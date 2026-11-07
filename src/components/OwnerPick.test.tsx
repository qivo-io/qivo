// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../../convex/lib/limits'
import {
  isOwnerPickerRead,
  type OwnerPickerArgs,
  ownerPickersStandIn,
} from '../store/ownerPickersStandIn.setup'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The owner list on the real store, read from the server's owner pickers
   through the stand-in (store/ownerPickersStandIn.setup.ts): nothing read
   before it opens or after it closes, Unassigned and the current holder
   apart from the batches, the server's search and Load more, every state
   in its own words, and a pick that counts on the Team sync row (onPick)
   only once the server saves it. Each task write is answered by hand. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('../store/guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

type Answer = { resolve: (value: null) => void; reject: (reason: unknown) => void }
type Planner = typeof import('../store/planner')['P']
type Caps = typeof import('../lib/pickerCaps')['PICKER_CAPS']

const NOW = '2026-09-14T08:00:00.000Z'
const FIRST =
  'Aisha Ben Carla Dmitri Elena Farid Grace Hugo Ines Jonas Keiko Liam Maya Nora Omar Priya Quinn Rosa Sven Tara Umar Vera Wes Ximena Yusuf Zara Alba Bruno Chloe Diego Emil Freya Gus Hana Ivan Jade Kofi Lena Mateo Noor'.split(
    ' ',
  )
const LAST =
  'Rahman Carter Silva Ivanov Rossi Haddad Kim Moreau Costa Berg Tanaka Walsh Patel Martins Farouk Nair Lopez Novak Larsen Singh Okafor Weber Dubois Garcia Yilmaz Mensah Hughes Sato Byrne Fischer'.split(
    ' ',
  )
const HOLDER = 'zoe'

let P: Planner
let caps: Caps
let snap: Snapshot
let container: HTMLDivElement
let root: Root
let writes: Answer[]
let onPick: ReturnType<typeof vi.fn<() => void>>
let force: Set<string>
/** every pickers: read the store sent, in order */
let asked: { name: string; args: OwnerPickerArgs }[]
/** reads held back while `holding`, released by hand */
let held: { name: string; args: OwnerPickerArgs; release: () => void }[]
let holding: boolean
/** whether people.byIds answers, for the people the snapshot holds */
let byIds: boolean

/** Adds `count` people of ordinary names to the fixture's organization,
    the first `viewers` of them organization Viewers, whom no list
    offers. */
function addPeople(count: number, viewers = 0) {
  const org = snap.orgs[0].id
  for (let i = 0; i < count; i++) {
    const name = `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`
    snap.profiles.push({
      ...snap.profiles[0],
      id: `person-${String(i).padStart(4, '0')}`,
      org_id: org,
      auth_user_id: `account-${i}`,
      name,
      initials: name
        .split(' ')
        .map((part) => part[0])
        .join(''),
      org_role: i < viewers ? 'viewer' : 'user',
    })
  }
}

/** Boots the store on the fixture with `people` people and Zoe Young,
    with `john` John Smith, whom only a whole word of his name finds, and
    with `edward` Edward Stone, whose first two letters "Unassigned"
    also holds. Zoe holds the task, or `holder`, an id the organization
    may not hold. */
async function load({
  people = 30,
  viewers = 0,
  john = false,
  edward = false,
  holder = HOLDER,
}: {
  people?: number
  viewers?: number
  john?: boolean
  edward?: boolean
  holder?: string
} = {}) {
  vi.resetModules()
  snap = plannerFixture()
  addPeople(people, viewers)
  if (john)
    snap.profiles.push({
      ...snap.profiles[0],
      id: 'john',
      auth_user_id: 'account-john',
      name: 'John Smith',
      initials: 'JS',
      org_role: 'user',
    })
  if (edward)
    snap.profiles.push({
      ...snap.profiles[0],
      id: 'edward',
      auth_user_id: 'account-edward',
      name: 'Edward Stone',
      initials: 'ES',
      org_role: 'user',
    })
  snap.profiles.push({
    ...snap.profiles[0],
    id: HOLDER,
    auth_user_id: 'account-zoe',
    name: 'Zoe Young',
    initials: 'ZY',
    org_role: 'user',
  })
  snap.issues.push({
    id: 'task-a',
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
    num: 27,
    title: 'Run the soak test',
    description: '',
    status: 'progress',
    priority: 'medium',
    paused: false,
    assignee_id: holder,
    created_at: NOW,
    updated_at: NOW,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  network.onUpdate.mockImplementation((ref, args: { ids?: string[] }, next) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    // people.byIds answers after its subscription opens, as the server does
    if (name === 'people:byIds' && byIds)
      void Promise.resolve().then(() =>
        next({ rows: snap.profiles.filter((p) => args.ids?.includes(p.id)) }),
      )
    return () => {}
  })
  const store = await import('../store/planner')
  P = store.P
  caps = (await import('../lib/pickerCaps')).PICKER_CAPS
  await store.initStore()
}

/* Renders `ui` in the test's root. */
async function render(ui: React.ReactNode) {
  const { TooltipProvider } = await import('./ui/tooltip')
  await act(async () => root.render(<TooltipProvider>{ui}</TooltipProvider>))
  await settle()
}

/** The task as the store shows it. */
function task() {
  const found = P.issues.find((i) => i.uuid === 'task-a')
  if (!found) throw new Error('missing the task')
  return found
}

/** Renders the owner list on the task, open, with `off` when given. */
async function openList(off?: string, onClose: (then: () => void) => void = (then) => then()) {
  const { OwnerPickList } = await import('./AssigneeAvatar')
  await render(<OwnerPickList issue={task()} onClose={onClose} onPick={onPick} off={off} />)
}

/** A few turns for the reads' answers and React. */
async function settle() {
  for (let i = 0; i < 3; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}

/** Past the search's rest, with the answers in. */
async function rest() {
  await act(async () => await new Promise((r) => setTimeout(r, 300)))
  await settle()
}

const items = () => [...document.querySelectorAll<HTMLElement>('[cmdk-item]')]
const names = () =>
  items()
    .filter((item) => !item.hasAttribute('data-picker-more'))
    .map((item) => item.querySelector('span.truncate, span.block')?.textContent ?? '')
const choices = () => [...document.querySelectorAll<HTMLElement>('[data-owner-choice]')]
const choiceIds = () => choices().map((item) => item.dataset.ownerChoice)
const holderRow = () => document.querySelector<HTMLElement>('[data-owner-holder]')
const unassigned = () => items().find((item) => item.textContent === 'Unassigned')
const moreButton = () => document.querySelector<HTMLElement>('[data-picker-more]')
const searchBox = () => document.querySelector<HTMLInputElement>('[data-owner-search]')
const listText = () => document.querySelector('[cmdk-list]')?.textContent ?? ''
const reads = (name: string) => asked.filter((a) => a.name === name)
const selected = () => items().find((item) => item.getAttribute('aria-selected') === 'true')

/** The rows of the stand-in's batch for `args`, by id. */
function batchIds(args: Partial<OwnerPickerArgs> = {}) {
  const answer = ownerPickersStandIn(snap, 'pickers:taskOwners', {
    org_id: snap.orgs[0].id,
    issue_id: 'task-a',
    field: 'assignee',
    ...args,
  })
  if (answer.state !== 'ready' || !('next' in answer)) throw new Error('no batch')
  return { ids: answer.rows.map((row) => row.id), next: answer.next }
}

/** Types `text` into the search box, as a person does. */
async function type(text: string) {
  const box = searchBox()
  if (!box) throw new Error('missing the search box')
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setValue?.call(box, text)
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Presses `key` in the search box; true when the app took it. */
async function press(key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  await act(async () => searchBox()?.dispatchEvent(event))
  return event.defaultPrevented
}

async function more() {
  await act(async () => moreButton()?.click())
  await settle()
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // cmdk measures its list
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  Element.prototype.scrollIntoView = () => {}
  window.showToast = vi.fn()
  writes = []
  asked = []
  held = []
  holding = false
  byIds = false
  force = new Set()
  network.query.mockImplementation(async (ref, args: OwnerPickerArgs) => {
    const name = getFunctionName(ref)
    if (!isOwnerPickerRead(name)) return null
    asked.push({ name, args })
    if (holding) await new Promise<void>((release) => held.push({ name, args, release }))
    return structuredClone(ownerPickersStandIn(snap, name, args, force))
  })
  network.mutation.mockImplementation(
    (ref) =>
      new Promise((resolve, reject) => {
        if (getFunctionName(ref) !== 'issues:update') return resolve(null)
        writes.push({ resolve, reject })
      }),
  )
  onPick = vi.fn<() => void>()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the owner list reads', () => {
  it('nothing before it opens, one first batch and one check on open, and nothing after it closes', async () => {
    await load()
    const { AssigneeAvatar } = await import('./AssigneeAvatar')
    await render(<AssigneeAvatar issue={task()} />)
    expect(asked).toEqual([])
    holding = true
    await act(async () => document.querySelector<HTMLElement>('[data-assignee-edit]')?.click())
    await settle()
    expect(reads('pickers:taskOwners')).toHaveLength(1)
    const first = reads('pickers:taskOwners')[0].args
    expect(first).toEqual({ org_id: snap.orgs[0].id, issue_id: 'task-a', field: 'assignee' })
    expect(reads('pickers:canOwn').map((a) => a.args)).toEqual([
      { org_id: snap.orgs[0].id, issue_id: 'task-a', field: 'assignee', ids: [HOLDER] },
    ])
    // closed before the answers arrive, which then change nothing and read
    // no more
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    await settle()
    expect(document.querySelector('[cmdk-root]')).toBeNull()
    await act(async () => {
      for (const h of held) h.release()
    })
    await settle()
    expect(document.querySelector('[cmdk-root]')).toBeNull()
    expect(asked).toHaveLength(2)
  })

  it('shows Unassigned, then the holder checked, then 25 people in the server’s order', async () => {
    await load()
    await openList()
    const { ids } = batchIds()
    expect(unassigned()).toBeDefined()
    expect(items()[0]).toBe(unassigned())
    expect(items()[1]).toBe(holderRow())
    expect(holderRow()?.textContent).toContain('Zoe Young')
    expect(holderRow()?.querySelector('[data-owner-ineligible]')).toBeNull()
    expect(choiceIds()).toEqual(ids.filter((id) => id !== HOLDER))
    expect(choiceIds()).toHaveLength(25)
  })

  it('lists a holder outside the first batch once, from the check, never again in a later batch', async () => {
    await load()
    await openList()
    expect(batchIds().ids).not.toContain(HOLDER)
    expect(holderRow()?.textContent).toContain('Zoe Young')
    while (moreButton()) await more()
    // Zoe Young sorts last, so the last batch holds her
    expect(reads('pickers:taskOwners').length).toBeGreaterThan(1)
    expect(items().filter((item) => item.textContent?.includes('Zoe Young'))).toHaveLength(1)
    expect(choiceIds()).not.toContain(HOLDER)
    expect(reads('pickers:canOwn')).toHaveLength(1)
  })

  it('marks a holder the check says can no longer take the task, and never offers them', async () => {
    force.add('check-ineligible')
    await load()
    await openList()
    expect(holderRow()?.getAttribute('aria-disabled')).toBe('true')
    expect(holderRow()?.textContent).toContain('Can no longer take this task')
  })

  it('leaves a holder named and checked, with no note, when the check fails', async () => {
    force.add('check-error')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await load()
    await openList()
    expect(holderRow()?.textContent).toContain('Zoe Young')
    expect(holderRow()?.getAttribute('aria-disabled')).not.toBe('true')
    expect(holderRow()?.querySelector('[data-owner-ineligible]')).toBeNull()
  })
})

describe('the owner list’s search', () => {
  it('asks the server once typing rests, and shows its rows as they come', async () => {
    await load({ john: true })
    await openList()
    await type('Sm')
    await type('Smith')
    expect(reads('pickers:taskOwners')).toHaveLength(1)
    await rest()
    expect(reads('pickers:taskOwners').map((a) => a.args.search)).toEqual([undefined, 'Smith'])
    // the browser does not filter the server's rows, and none holds
    // "smith" in its id
    expect(choiceIds()).toEqual(['john'])
    // Unassigned shows under a search only when its label holds the words
    expect(unassigned()).toBeUndefined()
    await type('unass')
    await rest()
    expect(unassigned()).toBeDefined()
  })

  it('matches no fuzzy text in the browser, and says nothing matches at the real end', async () => {
    await load({ john: true })
    await openList()
    await type('jsm')
    await rest()
    expect(choiceIds()).toEqual([])
    expect(listText()).toContain('No matching assignees.')
  })

  it('says nothing matches only at the real end, never after a stopped batch', async () => {
    force.add('stopped')
    await load()
    await openList()
    await type('nobody here')
    await rest()
    expect(listText()).not.toContain('No matching assignees.')
    expect(listText()).toContain('Showing the people found so far.')
    expect(moreButton()).not.toBeNull()
  })

  it('never shows an older text’s answer for a newer text', async () => {
    await load()
    await openList()
    holding = true
    await type('Aisha')
    await rest()
    await type('Ben')
    await rest()
    const [aisha, ben] = held
    expect(aisha.args.search).toBe('Aisha')
    expect(ben.args.search).toBe('Ben')
    await act(async () => ben.release())
    await settle()
    const shownForBen = choiceIds()
    expect(shownForBen.length).toBeGreaterThan(0)
    expect(names().some((name) => name.startsWith('Ben '))).toBe(true)
    await act(async () => aisha.release())
    await settle()
    expect(choiceIds()).toEqual(shownForBen)
  })

  it('says the limit past it and asks nothing', async () => {
    await load()
    await openList()
    await type('a'.repeat(LIMITS.search.max + 1))
    await rest()
    expect(reads('pickers:taskOwners')).toHaveLength(1)
    expect(listText()).toContain('Search for fewer words.')
  })

  it('takes Enter only on the answer for the typed text, never as Unassigned', async () => {
    await load()
    await openList()
    holding = true
    await type('Ben')
    // the answer is on its way, so Enter does nothing
    expect(await press('Enter')).toBe(true)
    await rest()
    expect(await press('Enter')).toBe(true)
    expect(writes).toHaveLength(0)
    await act(async () => {
      for (const h of held) h.release()
    })
    await settle()
    const first = choices()[0]
    expect(first.textContent).toContain('Ben ')
    expect(selected()).toBe(first)
    await press('Enter')
    await settle()
    expect(writes).toHaveLength(1)
    expect(network.mutation.mock.calls.at(-1)?.[1]).toMatchObject({
      patch: { assignee_id: first.dataset.ownerChoice },
    })
  })

  it('takes Enter on a person when the clear row’s label also holds the typed words', async () => {
    await load({ edward: true })
    await openList()
    holding = true
    await type('Ed')
    await rest()
    await act(async () => {
      for (const h of held) h.release()
    })
    await settle()
    // "ed" is in "Unassigned" too, which shows, yet Edward takes Enter
    expect(unassigned()).toBeDefined()
    expect(choiceIds()).toEqual(['edward'])
    expect(selected()?.dataset.ownerChoice).toBe('edward')
    await press('Enter')
    await settle()
    expect(writes).toHaveLength(1)
    expect(network.mutation.mock.calls.at(-1)?.[1]).toMatchObject({
      patch: { assignee_id: 'edward' },
    })
  })
})

describe('the owner list’s batches and states', () => {
  it('appends the next batch with Load more and moves the highlight to its first row', async () => {
    await load({ people: 60 })
    await openList()
    const { ids, next } = batchIds()
    await more()
    const second = batchIds({ after: next ?? undefined }).ids.filter((id) => id !== HOLDER)
    expect(choiceIds()).toEqual([...ids, ...second].filter((id) => id !== HOLDER))
    expect(selected()?.dataset.ownerChoice).toBe(second[0])
    expect(document.activeElement).toBe(searchBox())
  })

  it('asks for a search past its cap', async () => {
    await load({ people: 120 })
    caps.owners = 75
    try {
      await openList()
      await more()
      expect(listText()).not.toContain('Search to narrow the list.')
      await more()
      expect(choiceIds().length).toBeGreaterThanOrEqual(74)
      expect(listText()).toContain('Search to narrow the list.')
      expect(moreButton()).toBeNull()
    } finally {
      caps.owners = 500
    }
  })

  it('shows a stopped batch’s line beside Load more, never an end', async () => {
    force.add('stopped')
    await load()
    await openList()
    expect(listText()).toContain('Showing the people found so far.')
    expect(moreButton()).not.toBeNull()
    expect(listText()).not.toContain('No one can be assigned to this task.')
  })

  const states: [string, string, boolean][] = [
    ['not-ready', "People can't be listed yet.", false],
    ['refused', 'No write access to this project.', false],
    ['unavailable', 'This task is no longer available.', false],
    ['over-budget', "Qivo couldn't check who can take this task.", false],
    ['error', "Couldn't load people.", true],
  ]
  for (const [state, line, retry] of states)
    it(`says “${line}” for ${state}`, async () => {
      force.add(state)
      if (state === 'error') vi.spyOn(console, 'error').mockImplementation(() => {})
      await load()
      await openList()
      expect(listText()).toContain(line)
      expect(choices()).toEqual([])
      expect(listText()).not.toContain('No one can be assigned to this task.')
      expect(!!document.querySelector('[data-picker-retry]')).toBe(retry)
      // a list the server would not open takes no clear either
      const closed = state === 'refused' || state === 'unavailable'
      expect(unassigned()?.getAttribute('aria-disabled') === 'true').toBe(closed)
    })

  it('says why a reviewer list on a task with subtasks lists no one, and keeps No reviewer', async () => {
    force.add('group')
    await load()
    const { OwnerPickList } = await import('./AssigneeAvatar')
    await render(<OwnerPickList issue={task()} field="reviewer" onClose={(then) => then()} />)
    expect(listText()).toContain(
      'A task with subtasks has no reviewer of its own; set reviewers on its subtasks.',
    )
    expect(document.querySelector('[data-picker-retry]')).toBeNull()
    // the write still clears a reviewer the task kept from before
    const clear = items().find((item) => item.textContent === 'No reviewer')
    expect(clear).toBeDefined()
    expect(clear?.getAttribute('aria-disabled')).not.toBe('true')
  })

  it('names a holder the organization does not hold by the field’s own label, marked', async () => {
    byIds = true
    await load({ holder: 'gone-person' })
    await openList()
    const row = holderRow()
    expect(row?.textContent).toContain('Unassigned')
    expect(row?.textContent).not.toContain('Loading…')
    expect(row?.textContent).toContain('Can no longer take this task')
    expect(row?.getAttribute('aria-disabled')).toBe('true')
  })

  // the people figure at its design size, 1,000 people with the fixture's
  // Planner and Zoe Young, 995 of them eligible
  it('lists 1,000 people 25 at a time up to its cap of 500, each once', async () => {
    await load({ people: 998, viewers: 5 })
    await openList()
    expect(choices()).toHaveLength(25)
    for (let press = 0; press < 19; press++) await more()
    const ids = choiceIds()
    expect(ids).toHaveLength(500)
    expect(new Set(ids).size).toBe(500)
    expect(listText()).toContain('Search to narrow the list.')
    expect(moreButton()).toBeNull()
  }, 60_000)
})

describe('the owner list’s pick', () => {
  it('writes the person and runs onPick once the server saves the pick', async () => {
    await load()
    await openList()
    const person = choices()[0]
    await act(async () => person.click())
    expect(writes).toHaveLength(1)
    expect(network.mutation.mock.calls.at(-1)?.[1]).toMatchObject({
      patch: { assignee_id: person.dataset.ownerChoice },
    })
    expect(onPick).not.toHaveBeenCalled()
    await act(async () => writes[0].resolve(null))
    expect(onPick).toHaveBeenCalledTimes(1)
  })

  it('runs onPick once the server saves a clear', async () => {
    await load()
    await openList()
    await act(async () => unassigned()?.click())
    expect(writes).toHaveLength(1)
    await act(async () => writes[0].resolve(null))
    expect(onPick).toHaveBeenCalledTimes(1)
  })

  it('writes nothing while it may not write, every row and Load more saying why, and asks to close', async () => {
    await load()
    const why = 'This meeting stopped updating. Choose a smaller team or project.'
    const onClose = vi.fn()
    await openList(why, onClose)
    expect(onClose).toHaveBeenCalledTimes(1)
    const rows = items()
    expect(rows.length).toBeGreaterThan(2)
    expect(moreButton()).not.toBeNull()
    for (const row of rows) {
      expect(row.getAttribute('aria-disabled')).toBe('true')
      expect(row.title).toBe(why)
    }
    await act(async () => unassigned()?.click())
    await act(async () => choices()[0].click())
    expect(writes).toHaveLength(0)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('keeps no name for a holder picked while their name loads, and keeps a picked row’s', async () => {
    await load({ holder: 'unnamed' })
    holding = true
    await openList()
    const { ownerNameKept } = await import('./ownerNames')
    const org = snap.orgs[0].id
    expect(holderRow()?.textContent).toContain('Loading…')
    await act(async () => holderRow()?.click())
    expect(ownerNameKept(org, 'unnamed')).toBe(false)
    await act(async () => {
      for (const h of held) h.release()
    })
    await settle()
    const person = choices()[0]
    const id = person.dataset.ownerChoice ?? ''
    expect(ownerNameKept(org, id)).toBe(false)
    await act(async () => person.click())
    expect(ownerNameKept(org, id)).toBe(true)
  })

  it('leaves onPick out when the server refuses the pick', async () => {
    await load()
    await openList()
    await act(async () => unassigned()?.click())
    await act(async () =>
      writes[0].reject(new ConvexError({ code: 'forbidden', message: 'no write access' })),
    )
    expect(onPick).not.toHaveBeenCalled()
  })
})
