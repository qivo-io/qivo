// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { NO_PASSWORD_LOGIN } from '../../../convex/lib/email'
import { LIMITS } from '../../../convex/lib/limits'
import { TooltipProvider } from '../../components/ui/tooltip'
import { limitSentence, sentence } from '../../lib/fieldLimits'
import type { InviteDeliveryRow } from '../../lib/inviteDeliveries'
import { WHOLE } from '../../store/guard/liveDouble.setup'
import {
  type ForcedPeopleSettings,
  isPeopleSettingsRead,
  peopleSettingsServer,
  type StandInKey,
} from '../../store/peopleSettingsStandIn.setup'
import { plannerFixture, type Snapshot } from '../../store/plannerFixture.setup'

/* Organization > Users on the real store, its people read from the server
   a page at a time (people.settingsPage), which the people stand-in
   answers from the workspace the server holds (`snap`): the list and its
   ends, the rows kept through a search or a page move, the last-admin lock
   from the server's count, an agent's key lines and key panel read once
   (tokens.agentKeys), guests, invitation labels, the phone's user page and
   Settings' check of it, adding a person and editing an invitation's
   address. The fixture admin (me, Planner) manages Atlas, a Standard user
   agent, and Anna, invited at a Unicode domain. */

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

type Profile = Snapshot['profiles'][number]
type Pending = {
  name: string
  args: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (e: unknown) => void
}

// Imported after resetModules, so they share the store's module instances.
let pages: {
  users: typeof import('./UsersSettings')
  person: typeof import('./usePersonSettings')
  settings: typeof import('../Settings')
  version: typeof import('../../store/usePlannerVersion')
}
let store: typeof import('../../store/planner')
let safety: typeof import('../../lib/updateSafety')
let snap: Snapshot
let me: Profile
let server: ReturnType<typeof peopleSettingsServer>
let force: ForcedPeopleSettings
let extra: { keys: StandInKey[]; deliveries: InviteDeliveryRow[] }
let pending: Pending[]
let publish: (value: Snapshot) => void
let container: HTMLDivElement
let root: Root

/* A profile of the fixture's organization like me, a standard user with a
   login unless `over` says otherwise. */
const person = (id: string, name: string, over: Partial<Profile> = {}): Profile => ({
  ...me,
  id,
  name,
  org_role: 'user',
  auth_user_id: `account-${id}`,
  email: `${id}@example.test`,
  ...over,
})

/* `count` people named "Person 00" and on, which sort after Anna and Atlas
   and before Planner (me). */
const people = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => {
    const n = String(from + i).padStart(2, '0')
    return person(`p${n}`, `Person ${n}`)
  })

/* A key of `agent` as the server lists it. */
const keyOf = (agent: string, n: number, over: Partial<StandInKey> = {}): StandInKey => ({
  id: `${agent}-key-${n}`,
  agentId: agent,
  name: `Key ${n}`,
  prefix: `qva_00${n}...abcd${n}`,
  createdAt: `2026-10-0${n}T08:00:00.000Z`,
  lastUsedAt: null,
  revokedAt: null,
  ...over,
})

/* Loads the store over the fixture, with `build` adding to the workspace
   the server and the store both hold. */
async function load(build: (s: Snapshot) => void = () => {}) {
  vi.resetModules()
  snap = plannerFixture()
  me = snap.profiles[0]
  snap.profiles.push(
    person('atlas', 'Atlas', { kind: 'agent', auth_user_id: undefined, email: undefined }),
    person('anna', 'Anna Berg', { auth_user_id: undefined, email: 'anna@xn--bcher-kva.de' }),
  )
  build(snap)
  force = {}
  extra = { keys: [], deliveries: [] }
  pending = []
  server = peopleSettingsServer(
    () => snap,
    () => force,
    () => extra,
  )
  network.query.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    return isPeopleSettingsRead(name) ? server.query(name, args) : Promise.resolve([])
  })
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (isPeopleSettingsRead(name)) return server.watch(name, args, next, fail)
    if (name === WHOLE) publish = next
    next(structuredClone(snap))
    return () => {}
  })
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'identity:claimMySeats') return Promise.resolve(null)
    if (name === 'tokens:createAgentKey') {
      extra.keys.push({
        id: args.id,
        agentId: args.agent_id,
        name: args.name,
        prefix: args.key_prefix,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      })
      return Promise.resolve({ id: args.id })
    }
    if (name === 'tokens:revokeAgentKey') {
      const key = extra.keys.find((k) => k.id === args.id)
      if (key) key.revokedAt = new Date().toISOString()
      return Promise.resolve(true)
    }
    if (name === 'tokens:deleteAgentKey') {
      extra.keys = extra.keys.filter((k) => k.id !== args.id)
      return Promise.resolve(true)
    }
    return new Promise((resolve, reject) => pending.push({ name, args, resolve, reject }))
  })
  store = await import('../../store/planner')
  await store.initStore()
  pages = {
    users: await import('./UsersSettings'),
    person: await import('./usePersonSettings'),
    settings: await import('../Settings'),
    version: await import('../../store/usePlannerVersion'),
  }
  safety = await import('../../lib/updateSafety')
}

const narrowScreen = (narrow: boolean) =>
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: narrow, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  narrowScreen(false)
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  // a test that timed out inside a pause leaves the fake timers on
  vi.useRealTimers()
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(document, 'visibilityState')
  vi.unstubAllGlobals()
  network.mutation.mockReset()
  network.query.mockReset()
  network.onUpdate.mockReset()
})

/* Re-renders on every store change, as the app's shell does. */
function Live({ page }: { page: () => React.ReactNode }) {
  pages.version.usePlannerVersion()
  return <>{page()}</>
}

/* Lets the reads, the key hashing and the calls settle. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}
/* Lets a search rest past its 250 ms and settle. */
const rest = async () => {
  await act(async () => await new Promise((r) => setTimeout(r, 300)))
  await settle()
}

async function render(page: () => React.ReactNode) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Live page={page} />
      </TooltipProvider>,
    ),
  )
  await settle()
}

/* Renders the Users page. */
const show = () => render(() => <pages.users.OrgUsersPage setPage={vi.fn()} />)

function find<T extends Element = HTMLElement>(selector: string) {
  const element = container.querySelector<T>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}
const has = (selector: string) => container.querySelector(selector) !== null
const all = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)]
const pageRows = () => all('[data-org-users] [data-users-page-row]').map((r) => r.dataset.userRow)
const keptRows = () =>
  all('[data-org-users] [data-user-kept]').map((r) => [r.dataset.userRow, r.dataset.userKept])
const end = () => find('[data-users-end]')
const keyLine = (id: string) => find(`[data-agent-keyline="${id}"]`).textContent
const nameField = () => find<HTMLInputElement>('[data-agent-keys="atlas"] input')
const newKey = () => find<HTMLButtonElement>('[data-new-agent-key="atlas"]')
const createCalls = () =>
  network.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === 'tokens:createAgentKey')
const keyReads = () =>
  network.query.mock.calls
    .filter(([ref]) => getFunctionName(ref) === 'tokens:agentKeys')
    .map(([, args]) => args.agent_ids as string[])
const opened = (name: string) => server.open().filter((r) => r.name === name)

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
/* Presses `element` as a pointer does in a browser, focus moving to it
   first and then the click. */
async function click(element: HTMLElement) {
  await act(async () => {
    element.focus()
    element.click()
  })
  await settle()
}
/* The tooltip of `element`, as a pointer over it opens it, or null when it
   has none. */
async function hintOf(element: Element) {
  const trigger = element.closest<HTMLElement>('[data-tooltip-trigger]')
  if (!trigger) return null
  const pointer = (type: string) =>
    Object.assign(new MouseEvent(type, { bubbles: true }), { pointerType: 'mouse' })
  await act(async () => {
    trigger.dispatchEvent(pointer('pointermove'))
    await new Promise((resolve) => setTimeout(resolve, 400))
  })
  const said = document.querySelector('[data-slot="tooltip-content"]')?.firstChild?.textContent
  await act(async () => trigger.dispatchEvent(pointer('pointerleave')))
  await settle()
  return said ?? null
}
/* Types `text` in the search box, which takes focus first, as a person's
   typing gives it, and lets the search rest. */
const search = async (text: string) => {
  const box = find<HTMLInputElement>('[data-users-search]')
  await act(async () => box.focus())
  await type(box, text)
  await rest()
}

/* Renders the Users page and opens Atlas's keys. */
async function openKeys() {
  await show()
  await click(find('[data-user-row="atlas"] button[aria-label="Manage this agent\'s keys"]'))
}

const sentNames = () => network.mutation.mock.calls.map(([ref]) => getFunctionName(ref))

/* --------------------------------------------------------------- the list */

describe('the list', () => {
  it('reads one page at a time with Previous and Next, people before guests, rows painted from the store', async () => {
    await load((s) => {
      s.profiles.push(...people(30), person('gail', 'Gail Guest', { org_role: 'guest' }))
    })
    await show()
    // one live read of the first page, its arguments in a fixed key order
    expect(opened('people:settingsPage').map((r) => Object.keys(r.args))).toEqual([['org_id']])
    expect(pageRows()).toHaveLength(25)
    expect(pageRows().slice(0, 3)).toEqual(['anna', 'atlas', 'p00'])
    expect(has('[data-org-guests]')).toBe(false)
    expect(find('[data-org-users]').dataset.usersState).toBe('ok')
    // a rename in this session shows at once, before the server holds it
    store.P.updateUser('p00', { name: 'Paula Renamed' })
    await settle()
    expect(find<HTMLInputElement>('input[data-user-name="p00"]').value).toBe('Paula Renamed')

    const next = find<HTMLButtonElement>('[data-users-next]')
    next.focus()
    await click(next)
    expect(pageRows()).toEqual(['p23', 'p24', 'p25', 'p26', 'p27', 'p28', 'p29', me.id, 'gail'])
    expect(find('[data-org-guests]').textContent).toContain('Guests')
    expect(find('[data-org-guests]').textContent).toContain(
      'Guest hours apply within this organization.',
    )
    expect(has('[data-guest-row]')).toBe(true)
    // focus moves to the first row's name field
    expect(document.activeElement).toBe(find('input[data-user-name="p23"]'))
    expect(opened('people:settingsPage').map((r) => Object.keys(r.args))).toEqual([
      ['org_id', 'after'],
    ])
    await click(find('[data-users-previous]'))
    expect(pageRows()).toHaveLength(25)
    expect(has('[data-users-previous]')).toBe(false)
  })

  it('searches names and addresses on the server once typing rests, from the first page', async () => {
    await load((s) => s.profiles.push(...people(30)))
    await show()
    await click(find('[data-users-next]'))
    await type(find<HTMLInputElement>('[data-users-search]'), 'p05@example')
    // nothing goes to the server before the typing rests
    expect(opened('people:settingsPage').map((r) => r.args.search)).toEqual([undefined])
    await rest()
    expect(opened('people:settingsPage').map((r) => r.args)).toEqual([
      { org_id: snap.orgs[0].id, search: 'p05@example' },
    ])
    expect(pageRows()).toEqual(['p05'])
    await search('nobody here')
    expect(end().textContent).toBe('No people match.')
    expect(end().dataset.usersEnd).toBe('none')
    // Escape clears a typed search first
    await act(async () =>
      find('[data-users-search]').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    )
    await rest()
    expect(pageRows()).toHaveLength(25)
  })

  it('says every end of the page, and never no match where a page stopped or failed', async () => {
    await load((s) => s.profiles.push(...people(30)))
    force = { notReady: true }
    await show()
    expect(end().textContent).toBe('The user list is not ready yet. Try again in a few minutes.')
    expect(pageRows()).toEqual([])
    force = { stop: 3 }
    await act(async () => server.rerun())
    await search('nobody here')
    expect(end().textContent).toContain(
      'Qivo checked part of the list and found nothing there yet. Next continues.',
    )
    expect(end().textContent).not.toContain('No people match.')
    await search('')
    expect(end().textContent).toContain('Qivo checked part of the list. Next continues.')
    force = { fail: ['settingsPage'] }
    await act(async () => server.rerun())
    expect(end().textContent).toContain("Couldn't load people.")
    expect(end().getAttribute('role')).toBe('alert')
    force = {}
    await click(find('[data-users-end] [data-page-retry]'))
    expect(pageRows()).toHaveLength(25)
    // a search past the limit keeps the last page and says why
    await type(find<HTMLInputElement>('[data-users-search]'), 'x'.repeat(LIMITS.search.max + 1))
    expect(end().textContent).toBe(limitSentence(LIMITS.search))
  })

  it('shows a person the store does not hold read-only, with a face and controls that wait', async () => {
    await load()
    await show()
    // the server holds a person the store does not
    snap.profiles.push(person('aaron', 'Aaron Unheld'))
    await act(async () => server.rerun())
    const row = find('[data-user-row="aaron"]')
    expect(pageRows()[0]).toBe('aaron')
    expect(row.querySelector('[data-person-face]')?.getAttribute('aria-label')).toBe('Aaron Unheld')
    expect(row.querySelector('[data-person-face]')?.textContent).toBe('AU')
    expect(row.querySelector('[aria-label="Unassigned"]')).toBeNull()
    expect(row.querySelector('[data-user-waiting]')).not.toBeNull()
    expect(row.querySelector('input[data-user-name]')).toBeNull()
    const role = find<HTMLSelectElement>('[data-user-role="aaron"]')
    expect(role.disabled).toBe(true)
    expect(find<HTMLInputElement>('[data-plannable-for="aaron"]').disabled).toBe(true)
    expect(
      row.querySelector<HTMLButtonElement>('button[aria-label="Loading this person…"]')?.disabled,
    ).toBe(true)
    // a row the store holds keeps its controls
    expect(find<HTMLSelectElement>('[data-user-role="anna"]').disabled).toBe(false)
  })

  it("turns a waiting row's invitation, project right and address off, saying so", async () => {
    await load((s) => {
      s.orgs[0].project_creators = 'selected'
    })
    await show()
    // the server holds a pending person the store does not, whose
    // invitation email the hourly cap held back
    snap.profiles.push(person('abby', 'Abby Unheld', { auth_user_id: undefined }))
    extra.deliveries.push({
      profile_id: 'abby',
      email: 'abby@example.test',
      state: 'held',
      since: new Date().toISOString(),
      free_at: null,
    })
    await act(async () => server.rerun())
    await settle()
    expect(opened('invites:deliveries').at(-1)?.args.profile_ids).toContain('abby')
    const again = find<HTMLButtonElement>('[data-invite-again="abby"]')
    expect(again.disabled).toBe(true)
    expect(again.hasAttribute('data-user-waiting')).toBe(true)
    expect(await hintOf(again)).toBe('Loading this person…')
    await click(again)
    expect(sentNames()).not.toContain('invites:sendAgain')
    const right = find<HTMLInputElement>('[data-can-create-projects="abby"]')
    expect(right.disabled).toBe(true)
    expect(await hintOf(right)).toBe('Loading this person…')
    // the address line says why too
    const address = find('[data-user-email="abby"]')
    expect(address.hasAttribute('data-user-waiting')).toBe(true)
    expect(address.querySelector('input')).toBeNull()
    expect(await hintOf(address)).toBe('Loading this person…')
    // a row the store holds keeps its checkbox, with no such hint
    const held = find<HTMLInputElement>('[data-can-create-projects="anna"]')
    expect(held.disabled).toBe(false)
    expect(await hintOf(held)).toBeNull()
  })

  it('reads nothing while the tab is hidden, and reads again on return', async () => {
    await load()
    await show()
    expect(opened('people:settingsPage')).toHaveLength(1)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(opened('people:settingsPage')).toHaveLength(0)
    expect(pageRows()).toHaveLength(3)
    const reads = keyReads().length
    server.hold(true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(opened('people:settingsPage')).toHaveLength(1)
    expect(find('[data-org-users]').dataset.usersState).toBe('refreshing')
    server.hold(false)
    await act(async () => server.rerun())
    await settle()
    expect(find('[data-org-users]').dataset.usersState).toBe('ok')
    // the refresh reads the key lines again, once
    expect(keyReads().length).toBe(reads + 1)
  })

  it('opens on the page it was left on, read again', async () => {
    await load((s) => s.profiles.push(...people(30)))
    await show()
    await click(find('[data-users-next]'))
    await act(async () => root.render(null))
    expect(opened('people:settingsPage')).toHaveLength(0)
    await show()
    expect(pageRows()[0]).toBe('p23')
    expect(opened('people:settingsPage')[0].args).toHaveProperty('after')
  })
})

/* ------------------------------------------------------------ kept rows */

describe('kept rows', () => {
  it('keeps a person added here, Added, until a page holds them, and drops one the server refused', async () => {
    await load((s) => s.profiles.push(...people(30)))
    await show()
    await type(find<HTMLInputElement>('input[aria-label="New person name"]'), 'Zed New')
    await type(find<HTMLInputElement>('[data-add-email]'), 'zed@example.test')
    await click(find('[data-add-user]'))
    const create = pending.find((p) => p.name === 'profiles:create')
    const id = String(create?.args.id)
    expect(keptRows()).toEqual([[id, 'added']])
    expect(find(`[data-user-row="${id}"] [data-kept-note]`).textContent).toBe('Added')
    // the server holds them on the second page; the first does not
    snap.profiles.push(person(id, 'Zed New'))
    await act(async () => server.rerun())
    expect(keptRows()).toEqual([[id, 'added']])
    await click(find('[data-users-next]'))
    expect(pageRows()).toContain(id)
    expect(keptRows()).toEqual([])
    // once a page has held them, they are no longer kept elsewhere
    await click(find('[data-users-previous]'))
    expect(keptRows()).toEqual([])

    await type(find<HTMLInputElement>('input[aria-label="New person name"]'), 'Yan Refused')
    await type(find<HTMLInputElement>('[data-add-email]'), 'yan@example.test')
    await click(find('[data-add-user]'))
    const refused = pending.filter((p) => p.name === 'profiles:create').at(-1)
    expect(keptRows()).toEqual([[String(refused?.args.id), 'added']])
    await act(async () =>
      refused?.reject(new ConvexError({ code: 'rule', message: 'that address has a seat' })),
    )
    await settle()
    expect(keptRows()).toEqual([])
  })

  it('keeps a drafted name, address and hours through a search and a page move, and lets them go once settled', async () => {
    await load((s) => s.profiles.push(...people(30)))
    await show()
    const over = 'x'.repeat(LIMITS.personName.max + 1)
    // a name over the limit and hours out of range stay typed when their
    // field loses focus, refused
    const name = find<HTMLInputElement>('input[data-user-name="p00"]')
    await act(async () => name.focus())
    await type(name, over)
    const hours = find<HTMLInputElement>('[data-plannable-for="p01"]')
    await act(async () => hours.focus())
    await type(hours, '500')
    // an address changed elsewhere while it is typed waits for Use saved or
    // Keep mine
    const email = find<HTMLInputElement>('input[data-user-email="anna"]')
    await act(async () => email.focus())
    await type(email, 'anna.new@example.test')
    const anna = snap.profiles.find((p) => p.id === 'anna')
    if (anna) anna.email = 'anna.other@example.test'
    await act(async () => publish(structuredClone(snap)))
    await search('planner')
    expect(pageRows()).toEqual([me.id])
    expect(keptRows().sort()).toEqual(
      [
        ['anna', 'kept'],
        ['p00', 'kept'],
        ['p01', 'kept'],
      ].sort(),
    )
    // the same fields, with their text
    expect(find<HTMLInputElement>('input[data-user-name="p00"]')).toBe(name)
    expect(name.value).toBe(over)
    expect(find<HTMLInputElement>('input[data-user-email="anna"]').value).toBe(
      'anna.new@example.test',
    )
    expect(find<HTMLInputElement>('[data-plannable-for="p01"]').value).toBe('500')
    expect(find('[data-user-row="p00"] [data-kept-note]').textContent).toBe('Not on this page')
    expect(sentNames()).not.toContain('profiles:update')
    await search('')
    expect(keptRows()).toEqual([])
    await click(find('[data-users-next]'))
    expect(find<HTMLInputElement>('input[data-user-name="p00"]').value).toBe(over)
    // a kept row stays while its field holds focus, also as its text passes
    // through the saved name
    const kept = find<HTMLInputElement>('input[data-user-name="p00"]')
    await act(async () => kept.focus())
    await type(kept, 'Person 00')
    expect(keptRows().map(([id]) => id)).toContain('p00')
    await type(kept, over)
    // Escape puts the saved name back, and the row is no longer kept
    await act(async () =>
      find('input[data-user-name="p00"]').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    )
    // the field's open tooltip takes the press and sends it on (passEscapeOn)
    await vi.waitFor(() => expect(keptRows().map(([id]) => id)).not.toContain('p00'))
    expect(
      keptRows()
        .map(([id]) => id)
        .sort(),
    ).toEqual(['anna', 'p01'])
  })

  it('keeps a row whose rename or address waits for the server through a search, and brings a refused one back in it', async () => {
    await load((s) => s.profiles.push(...people(30)))
    await show()
    const name = find<HTMLInputElement>('input[data-user-name="p00"]')
    await act(async () => name.focus())
    await type(name, 'Paula New')
    const email = find<HTMLInputElement>('input[data-user-email="anna"]')
    // focus moves on, so the rename saves on its way out, and the address
    // as the search box takes focus
    await act(async () => email.focus())
    await type(email, 'anna.new@example.test')
    await search('planner')
    const sent = (id: string) =>
      pending.find((p) => p.name === 'profiles:update' && p.args.id === id)
    expect(sent('p00')?.args).toMatchObject({ patch: { name: 'Paula New' } })
    expect(sent('anna')?.args).toMatchObject({ patch: { email: 'anna.new@example.test' } })
    // the store painted both, which read as saved, but the rows wait for
    // the server's answers
    expect(pageRows()).toEqual([me.id])
    expect(keptRows().sort()).toEqual(
      [
        ['anna', 'kept'],
        ['p00', 'kept'],
      ].sort(),
    )
    // the server takes the address, and Anna's row goes
    await act(async () => sent('anna')?.resolve(null))
    await settle()
    expect(keptRows()).toEqual([['p00', 'kept']])
    // someone else renamed Person 00 first, so the server refuses the rename
    const p00 = snap.profiles.find((p) => p.id === 'p00')
    if (p00) p00.name = 'Paula Other'
    await act(async () => publish(structuredClone(snap)))
    await act(async () =>
      sent('p00')?.reject(
        new ConvexError({
          code: 'conflict',
          reason: 'field_changed',
          message: 'name changed since you read it',
          changes: [
            { record: 'profile', id: 'p00', field: 'name', by: null, at: new Date().toISOString() },
          ],
        }),
      ),
    )
    await settle()
    // the same field holds the typed name, with the name the server keeps
    expect(keptRows()).toEqual([['p00', 'kept']])
    expect(find<HTMLInputElement>('input[data-user-name="p00"]')).toBe(name)
    expect(name.value).toBe('Paula New')
    expect(find('[data-user-row="p00"] [data-draft-conflict]').textContent).toContain(
      'Changed elsewhere to “Paula Other”.',
    )
    // Use saved lets the draft go, and the row with it once focus leaves
    await click(find('[data-user-row="p00"] [data-draft-use-saved]'))
    expect(name.value).toBe('Paula Other')
    await act(async () => find<HTMLInputElement>('[data-users-search]').focus())
    expect(keptRows()).toEqual([])
    expect(pending.filter((p) => p.name === 'profiles:update')).toHaveLength(2)
  })

  it("keeps the open key panel's row and its fresh secret through a page move", async () => {
    await load((s) => s.profiles.push(...people(30)))
    await openKeys()
    await type(nameField(), 'CI runner')
    await click(newKey())
    const secret = find('[data-agent-keys="atlas"] [data-fresh-key]').textContent
    expect(secret).toMatch(/qva_[0-9a-f]{48}/)
    await click(find('[data-users-next]'))
    expect(keptRows()).toEqual([['atlas', 'kept']])
    expect(find('[data-agent-keys="atlas"] [data-fresh-key]').textContent).toBe(secret)
  })

  it('hides a row removed here while its removal is on its way, and shows it again after a refusal', async () => {
    await load((s) => s.profiles.push(...people(3)))
    await show()
    const remove = () =>
      find(
        '[data-user-row="p01"] button[aria-label*="Remove from the organization"], [data-user-row="p01"] button[aria-label="Click again to confirm removal"]',
      )
    await click(remove())
    await act(async () => await new Promise((r) => setTimeout(r, 550)))
    await click(remove())
    expect(has('[data-user-row="p01"]')).toBe(false)
    const sent = pending.find((p) => p.name === 'profiles:remove')
    await act(async () => sent?.reject(new ConvexError({ code: 'rule', message: 'not now' })))
    await settle()
    expect(has('[data-user-row="p01"]')).toBe(true)
  })
})

/* ------------------------------------------------------- the last admin */

describe('the last-admin lock', () => {
  it("locks the only admin's role from the server's count, also while it is unknown", async () => {
    // a second admin, switched off, on the first page; me on the second
    await load((s) =>
      s.profiles.push(
        ...people(30),
        person('zadmin', 'Aaron Admin', { org_role: 'admin', active: false }),
      ),
    )
    await show()
    const role = () => find<HTMLSelectElement>(`[data-user-role="${me.id}"]`)
    await click(find('[data-users-next]'))
    expect(role().disabled).toBe(true)
    // a second active admin on no page on screen frees it
    const second = snap.profiles.find((p) => p.id === 'zadmin')
    if (second) second.active = true
    await act(async () => server.rerun())
    expect(role().disabled).toBe(false)
    // a page that failed holds no count, so the lock comes back
    force = { fail: ['settingsPage'] }
    await act(async () => server.rerun())
    expect(role().disabled).toBe(true)
    force = { admins: 2 }
    await click(find('[data-users-end] [data-page-retry]'))
    expect(role().disabled).toBe(false)
    force = { admins: 1 }
    await act(async () => server.rerun())
    expect(role().disabled).toBe(true)
  })
})

/* ------------------------------------------------ key lines and the panel */

describe('key lines and the key panel', () => {
  it('reads the lines once for the agents on screen, again after a page move and a key write, never subscribed', async () => {
    await load((s) =>
      s.profiles.push(
        ...people(30),
        person('zbot', 'Zeta Bot', { kind: 'agent', auth_user_id: undefined, email: undefined }),
      ),
    )
    extra.keys.push(keyOf('atlas', 1), keyOf('atlas', 2), keyOf('atlas', 3))
    await show()
    expect(keyReads()).toEqual([['atlas']])
    expect(keyLine('atlas')).toBe('qva_003...abcd3, +2 more')
    await click(find('[data-users-next]'))
    expect(keyReads()).toEqual([['atlas'], ['zbot']])
    expect(keyLine('zbot')).toBe('no key, cannot sign in')
    await click(find('[data-users-previous]'))
    expect(keyReads()).toHaveLength(3)
    await openKeys()
    const before = keyReads().length
    await type(nameField(), 'Deploy')
    await click(newKey())
    // the panel reads again, and the page's lines
    expect(keyReads().length).toBeGreaterThanOrEqual(before + 2)
    expect(keyLine('atlas')).toMatch(/, \+3 more$/)
    const reads = network.onUpdate.mock.calls.map(([ref]) => getFunctionName(ref))
    expect(reads).not.toContain('tokens:agentKeys')
    expect(reads).not.toContain('tokens:listAgentKeys')
  })

  it('says it is checking, that it could not check, and no key only from a complete answer', async () => {
    await load()
    let answer: (value: unknown) => void = () => {}
    network.query.mockImplementationOnce(() => new Promise((r) => (answer = r)))
    await show()
    expect(keyLine('atlas')).toBe('Checking keys…')
    await act(async () => answer({ agents: [{ agent_id: 'atlas', keys: [], more: false }] }))
    expect(keyLine('atlas')).toBe('no key, cannot sign in')

    /* Atlas's line for `keys` with the stand-in's states `forced`. */
    const lineFor = async (keys: StandInKey[], forced: ForcedPeopleSettings) => {
      await load()
      extra.keys.push(...keys)
      force = forced
      await show()
      return keyLine('atlas')
    }
    const revoked = { revokedAt: '2026-10-09T08:00:00.000Z' }
    expect(await lineFor([keyOf('atlas', 1)], { fail: ['agentKeys'] })).toBe("Couldn't check keys.")
    // the newest two hold one active key, and more lie past them
    expect(
      await lineFor([keyOf('atlas', 1), keyOf('atlas', 2), keyOf('atlas', 3, revoked)], {
        keysMost: 2,
      }),
    ).toBe('qva_002...abcd2, and maybe more')
    expect(
      await lineFor([keyOf('atlas', 1), keyOf('atlas', 2), keyOf('atlas', 3)], { keysMost: 2 }),
    ).toBe('qva_003...abcd3, +1 or more')
    // a revoked newest key and more past it is not "no key"
    expect(await lineFor([keyOf('atlas', 1), keyOf('atlas', 2, revoked)], { keysMost: 1 })).toBe(
      'No active key among the newest 50.',
    )
    expect(await lineFor([keyOf('atlas', 1, revoked)], {})).toBe('no key, cannot sign in')
  })

  it('reads 26 agents on screen in two calls', async () => {
    await load((s) =>
      s.profiles.push(
        ...Array.from({ length: 30 }, (_, i) =>
          person(`a${String(i).padStart(2, '0')}`, `Agent ${String(i).padStart(2, '0')}`, {
            kind: 'agent',
            auth_user_id: undefined,
            email: undefined,
          }),
        ),
      ),
    )
    await show()
    await click(find('[data-users-next]'))
    await click(find('[data-user-row="a27"] button[aria-label="Manage this agent\'s keys"]'))
    await click(find('[data-users-previous]'))
    const last = keyReads().slice(-2)
    expect(last.map((ids) => ids.length).sort()).toEqual([1, 25])
    expect(new Set(last.flat()).size).toBe(26)
    expect(keyLine('a27')).not.toBe("Couldn't check keys.")
  })

  it('opens the panel on its own read, with Retry, the newest 50 and an agent that left', async () => {
    await load()
    force = { fail: ['agentKeys'] }
    await openKeys()
    expect(find('[data-agent-keys="atlas"]').textContent).toContain("Couldn't load keys.")
    force = {}
    extra.keys.push(keyOf('atlas', 1), keyOf('atlas', 2))
    await click(find('[data-agent-keys-retry]'))
    expect(find('[data-agent-keys="atlas"]').dataset.agentKeysState).toBe('ok')
    expect(find('[data-agent-keys="atlas"]').textContent).toContain('Key 2')
    expect(has('[data-agent-keys-more]')).toBe(false)
    force = { keysMost: 1 }
    await type(nameField(), 'Third')
    await click(newKey())
    expect(find('[data-agent-keys-more]').textContent).toBe(
      'Showing the newest 50 keys. Organization › API access lists every key of this agent.',
    )
    // the server no longer holds Atlas as an agent of the organization
    snap.profiles = snap.profiles.filter((p) => p.id !== 'atlas')
    await type(nameField(), 'Fourth')
    await click(newKey())
    expect(find('[data-agent-keys="atlas"]').textContent).toContain(
      'This agent is no longer in the organization.',
    )
    expect(newKey().disabled).toBe(true)
  })
})

/* --------------------------------------------------------------- guests */

describe('guests', () => {
  it("names a guest's first projects, says when there are more, and no shared projects only when there are none", async () => {
    await load((s) => {
      const project = s.projects[0]
      const second = { ...project, id: 'second', name: 'Second project', key: 'SEC', num: 2 }
      const archived = {
        ...project,
        id: 'old',
        name: 'Old project',
        key: 'OLD',
        num: 3,
        archived_at: '2026-10-01T08:00:00.000Z',
      }
      s.projects.push(second, archived)
      s.profiles.push(
        person('gail', 'Gail Guest', { org_role: 'guest' }),
        person('gus', 'Gus Guest', { org_role: 'guest' }),
        person('gwen', 'Gwen Guest', { org_role: 'guest' }),
      )
      s.access.push(
        { project_id: project.id, profile_id: 'gail', level: 'user' },
        { project_id: 'second', profile_id: 'gail', level: 'viewer' },
        { project_id: 'old', profile_id: 'gwen', level: 'viewer' },
        { project_id: 'second', profile_id: 'gwen', level: 'viewer' },
      )
    })
    await show()
    const line = (id: string) => find(`[data-user-row="${id}"] [data-guest-projects]`).textContent
    expect(line('gail')).toBe('Task creation fixture (user), Second project (viewer)')
    expect(line('gus')).toBe('no shared projects')
    expect(line('gwen')).toBe('Second project (viewer)')
    force = { guestShown: 1 }
    await act(async () => server.rerun())
    expect(line('gail')).toBe('Task creation fixture (user), and more')
    expect(line('gwen')).toBe('Projects not listed here.')
    expect(line('gus')).toBe('no shared projects')
  })
})

/* ---------------------------------------------------------- invitations */

describe('invitation labels', () => {
  it('reads one invitation row per pending seat on screen, in one read', async () => {
    await load()
    extra.deliveries.push({
      profile_id: 'anna',
      email: 'anna@xn--bcher-kva.de',
      state: 'held',
      since: new Date().toISOString(),
      free_at: null,
    })
    await show()
    expect(opened('invites:deliveries').map((r) => r.args)).toEqual([
      { org_id: snap.orgs[0].id, profile_ids: ['anna'] },
    ])
    expect(find('[data-invite-for="anna"]').textContent).toBe('invitation not sent')
    expect(has('[data-invite-again="anna"]')).toBe(true)
  })
})

/* ------------------------------------------------ the phone and the shell */

describe("the phone's user page and Settings' check", () => {
  function Screen({ initial, reset }: { initial: string; reset: (page: string) => void }) {
    const [page, setPage] = useState(initial)
    return (
      <pages.settings.SettingsScreen
        page={page}
        setPage={setPage}
        resetPage={(next) => {
          reset(next)
          setPage(next)
        }}
        onExit={vi.fn()}
        onNewProject={vi.fn()}
        onNewSubProject={vi.fn()}
        onOpenArchivedTasks={vi.fn()}
      />
    )
  }

  it('opens a person on no loaded page from people.get, and goes back to the page it came from', async () => {
    await load((s) => s.profiles.push(...people(30)))
    narrowScreen(true)
    const reset = vi.fn()
    await render(() => <Screen initial="org-users" reset={reset} />)
    await click(find('[data-users-next]'))
    await click(find('[data-settings-open-user="p29"]'))
    expect(opened('people:get').map((r) => r.args)).toEqual([
      { org_id: snap.orgs[0].id, id: 'p29' },
    ])
    expect(find('[data-settings-user-detail]').dataset.settingsUserDetail).toBe('p29')
    expect(find('[data-settings-user-detail] h1').textContent).toBe('Person 29')
    expect(find<HTMLSelectElement>('[data-user-role="p29"]').disabled).toBe(false)
    await click(find('button[aria-label="Back to Users"]'))
    expect(pageRows()[0]).toBe('p23')
    expect(reset).not.toHaveBeenCalled()
  })

  it("reads no keys for the phone's list, which shows no key line, and an agent's on its page", async () => {
    await load()
    extra.keys.push(keyOf('atlas', 1))
    narrowScreen(true)
    await render(() => <Screen initial="org-users" reset={vi.fn()} />)
    expect(find('[data-settings-open-user="atlas"]').textContent).toContain('Agent')
    expect(has('[data-agent-keyline]')).toBe(false)
    expect(keyReads()).toEqual([])
    await click(find('[data-settings-open-user="atlas"]'))
    expect(keyReads()).toEqual([['atlas']])
    expect(keyLine('atlas')).toBe('qva_001...abcd1')
  })

  it('sends an unknown person and a guest back to Users, a non-admin to their account, and moves nothing while loading or failed', async () => {
    await load((s) => s.profiles.push(person('gail', 'Gail Guest', { org_role: 'guest' })))
    narrowScreen(true)
    const reset = vi.fn()
    await render(() => <Screen key="nobody" initial="user:nobody" reset={reset} />)
    expect(reset).toHaveBeenLastCalledWith('org-users')
    await render(() => <Screen key="gail" initial="user:gail" reset={reset} />)
    expect(reset).toHaveBeenLastCalledWith('org-users')

    reset.mockClear()
    server.hold(true)
    await render(() => <Screen key="anna" initial="user:anna" reset={reset} />)
    expect(find('[data-person-loading]').textContent).toBe('Loading this person…')
    expect(reset).not.toHaveBeenCalled()
    server.hold(false)
    force = { fail: ['get'] }
    await act(async () => server.rerun())
    await settle()
    expect(container.textContent).toContain("Couldn't load this person.")
    expect(reset).not.toHaveBeenCalled()
    force = {}
    await click(find('[data-person-retry]'))
    expect(find('[data-settings-user-detail] h1').textContent).toBe('Anna Berg')

    await load((s) => {
      s.profiles[0].org_role = 'user'
    })
    narrowScreen(true)
    const watched = network.onUpdate.mock.calls.length
    const away = vi.fn()
    await render(() => <Screen key="away" initial="user:anna" reset={away} />)
    expect(away).toHaveBeenLastCalledWith('account')
    // a seat that is not an admin reads nothing of people
    expect(
      network.onUpdate.mock.calls.slice(watched).map(([ref]) => getFunctionName(ref)),
    ).not.toContain('people:get')
  })
})

/* ------------------------------------------------------------ the store */

describe('P.agentKeys', () => {
  it('reads in calls of at most 25 ids, answers null when one fails, and sends a revoke to the organization it read', async () => {
    await load()
    const org = snap.orgs[0].id
    network.query.mockClear()
    const ids = Array.from({ length: 26 }, (_, i) => `x${i}`)
    // ids that name no agent are left out, a definite answer
    expect(await store.P.agentKeys(org, ids)).toEqual({ agents: [] })
    expect(keyReads().map((list) => list.length)).toEqual([25, 1])
    force = { fail: ['agentKeys'] }
    expect(await store.P.agentKeys(org, ['atlas'])).toBeNull()
    force = {}
    // a key of an agent of another organization, which the store does not hold
    network.query.mockImplementationOnce(async () => ({
      agents: [{ agent_id: 'far', keys: [keyOf('far', 1)], more: false }],
    }))
    expect((await store.P.agentKeys('other-org', ['far']))?.agents).toHaveLength(1)
    expect(await store.P.revokeAgentKey('far-key-1')).toBe(true)
    expect(
      network.mutation.mock.calls.find(
        ([ref]) => getFunctionName(ref) === 'tokens:revokeAgentKey',
      )?.[1],
    ).toEqual({ org_id: 'other-org', id: 'far-key-1' })
  })
})

/* -------------------------------------------------------------- New key */

describe('New key', () => {
  it('creates a key and shows its secret once', async () => {
    await load()
    await openKeys()
    // a pasted name over the cap stays whole, and New key waits for it
    await type(nameField(), 'k'.repeat(81))
    expect(nameField().value).toHaveLength(81)
    expect(newKey().disabled).toBe(true)
    await type(nameField(), 'CI runner')
    await click(newKey())

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
    await load()
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
    expect(createCalls()).toHaveLength(0)
    expect(window.showToast).toHaveBeenCalledWith("Couldn't create that key", 'error')
    expect(newKey().disabled).toBe(false)
    expect(safety.isUpdateBlocked()).toBe(false)

    // a typed name stays for a retry
    await type(nameField(), 'CI runner')
    await click(newKey())
    expect(createCalls()).toHaveLength(0)
    expect(window.showToast).toHaveBeenCalledTimes(2)
    expect(newKey().disabled).toBe(false)
    expect(nameField().value).toBe('CI runner')
  })
})

/* ----------------------------------------------------------- Add person */

describe('Add person', () => {
  const nameInput = () => find<HTMLInputElement>('input[aria-label="New person name"]')
  const addButton = () => find<HTMLButtonElement>('[data-add-user]')

  it('counts a name as the server stores it, with whitespace runs collapsed', async () => {
    await load()
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
    await load()
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
    await load()
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
    await load()
    await show()
    const field = find<HTMLInputElement>('input[data-user-email="anna"]')
    await act(async () => field.focus())
    await type(field, 'Anna@Bücher.de')
    await act(async () => field.blur())
    expect(sentNames()).not.toContain('profiles:update')
    expect(field.value).toBe('anna@xn--bcher-kva.de')
  })

  it('says why an address a password login cannot use is not saved, and restores the old one', async () => {
    await load()
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
