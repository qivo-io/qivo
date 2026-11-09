// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../../convex/lib/limits'
import { endClosing, playClosingAnimations } from '../lib/closingAnimation.setup'
import { subscribersStandIn, taskFollowersStandIn } from '../store/followerStandIn.setup'
import { plannerFixture, type Snapshot, underProgram } from '../store/plannerFixture.setup'
import { TooltipProvider } from './ui/tooltip'

/* A task's subscribers popover on the real store as it closes. A close
   leaves the person search as it was, so the closing popover keeps what it
   showed open but takes no press, and the next opening starts over. Aisha
   and Leo may be added; nobody follows the task yet. The store holds none
   of them: the roster names its followers from its own rows and the Add
   list reads the server's batches (store/followerStandIn.setup.ts). */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('../store/guard/liveDouble.setup')).liveOver(network, {
    taskWindow: 'client',
  }),
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

type Planner = typeof import('../store/planner')['P']
const NOW = '2026-09-14T08:00:00.000Z'

let P: Planner
let ui: typeof import('./IssueSubscribers')
let container: HTMLDivElement
let root: Root
let org: string
// the fixture's project, which the store reads by id
let projectId: string
/* How many more people the organization holds than Aisha and Leo, and who
   follows the task besides, as the roster answers. */
let crowd = 0
let followers: string[] = []
/* The roster's arguments, and the window's read of a task the workspace
   does not hold. */
let rosterArgs: Record<string, unknown>[] = []
/* The roster's open subscriptions, and, while `holdRoster` is set, the
   answers it holds back until a test gives them, or fails them. */
let rosterOpen = 0
let holdRoster = false
let heldRoster: { answer: () => void; fail: (error: unknown) => void }[] = []
let windowRead: ((value: unknown) => void) | null = null
/* The Add list's reads, each a batch the popover asked for. */
let candidateReads: Record<string, unknown>[] = []

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  // Radix measures the popover's anchor
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  playClosingAnimations()
  vi.resetModules()
  const snap: Snapshot = underProgram(plannerFixture())
  org = snap.orgs[0].id
  projectId = snap.projects[0].id
  const me = snap.profiles[0]
  for (const [id, name, email] of [
    ['aisha', 'Aisha Rahman', 'aisha@northstar.test'],
    ['leo', 'Leo Martins', 'leo@northstar.test'],
  ])
    snap.profiles.push({ ...me, id, name, email, initials: 'AR', auth_user_id: `account-${id}` })
  for (let i = 0; i < crowd; i++) {
    const id = `person-${String(i).padStart(4, '0')}`
    snap.profiles.push({ ...me, id, name: `Person ${id.slice(7)}`, auth_user_id: `account-${id}` })
  }
  rosterArgs = []
  rosterOpen = 0
  holdRoster = false
  heldRoster = []
  candidateReads = []
  windowRead = null
  snap.issues.push({
    id: 'task-a',
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
    num: 5,
    title: 'Reduce standby power consumption',
    description: '',
    status: 'progress',
    priority: 'high',
    paused: false,
    created_at: NOW,
    updated_at: NOW,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    if (name === 'taskWindow:task') windowRead = next
    if (name === 'issues:subscribers') {
      rosterArgs.push(args)
      rosterOpen++
      const answer = () => {
        const server = {
          ...snap,
          issueSubs: followers.map((id) => ({
            issue_id: String(args.issue_id),
            profile_id: id,
            created_at: NOW,
          })),
        }
        next(
          subscribersStandIn(server, args as { org_id: string; issue_id: string }, {
            canManage: true,
          }),
        )
      }
      if (holdRoster) heldRoster.push({ answer, fail: (error) => fail?.(error) })
      else answer()
      return () => {
        rosterOpen--
      }
    }
    return () => {}
  })
  network.query.mockImplementation(async (ref, args) => {
    if (getFunctionName(ref) !== 'pickers:taskFollowers') return null
    candidateReads.push(args)
    const server = {
      ...snap,
      issueSubs: followers.map((id) => ({
        issue_id: String(args.issue_id),
        profile_id: id,
        created_at: NOW,
      })),
    }
    return taskFollowersStandIn(server, args as { org_id: string; issue_id: string }, {
      canManage: true,
    })
  })
  network.mutation.mockResolvedValue(null)
  const store = await import('../store/planner')
  P = store.P
  await store.initStore()
  ui = await import('./IssueSubscribers')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  Reflect.deleteProperty(document, 'visibilityState')
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const popover = () => document.querySelector('[data-task-subscribers]')
const roster = () => document.querySelector('[data-task-subscribers-roster]')
const listed = () =>
  [...document.querySelectorAll('[data-task-subscriber]')].map((row) =>
    row.getAttribute('data-task-subscriber'),
  )
/** Sets the page's visibility, as the browser does when a tab hides. */
const setVisibility = (value: 'visible' | 'hidden') =>
  act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
    document.dispatchEvent(new Event('visibilitychange'))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
const search = () => document.querySelector<HTMLInputElement>('[data-task-subscriber-search]')
const offered = () =>
  [...document.querySelectorAll('[data-task-subscriber-add]')].map((row) =>
    row.getAttribute('data-task-subscriber-add'),
  )
const press = (selector: string) =>
  act(async () => document.querySelector<HTMLElement>(selector)?.click())

/* Renders the popover for task QN-40 from the window's own answer of it
   (P.taskDetail), as the app shows every task. */
async function showFromAnswer() {
  network.mutation.mockClear()
  P.watchComments('far', org)
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  const task = {
    id: 'far',
    org_id: org,
    project_id: projectId,
    num: 40,
    title: 'Tune the antenna',
    description: '',
    status: 'progress',
    priority: 'medium',
    paused: false,
    created_at: NOW,
    updated_at: NOW,
    has_subtasks: false,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  }
  await act(async () => {
    windowRead?.({
      state: 'ok',
      task,
      level: 'lead',
      labels: [],
      follow: null,
      parent: null,
      subtasks: { rows: [], complete: true },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const issue = P.taskDetail('far')?.view
  if (!issue) throw new Error('the window shows no task from its answer')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ui.IssueSubscribers issue={issue} />
      </TooltipProvider>,
    ),
  )
}
const writes = (name: string) =>
  network.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === name)
    .map(([, args]) => args)

describe('the task subscribers popover of a task the window shows from its own answer', () => {
  afterEach(() => {
    crowd = 0
    followers = []
  })

  it('reads the roster by the answer’s task, and adds and removes from it for a lead', async () => {
    followers = ['aisha']
    await showFromAnswer()
    await press('[data-task-subscribe]')
    expect(rosterArgs.at(-1)).toEqual({ org_id: org, issue_id: 'far' })
    await press('[data-task-subscriber-remove="aisha"]')
    expect(writes('issues:setSubscriber')).toEqual([
      { org_id: org, issue_id: 'far', profile_id: 'aisha', subscribed: false },
    ])
    await press('[data-task-subscriber-add-open]')
    // the Add list is the server's batch, which arrives after the press
    await vi.waitFor(() => expect(offered()).toContain('leo'))
    await press('[data-task-subscriber-add="leo"]')
    expect(writes('issues:setSubscriber').at(-1)).toEqual({
      org_id: org,
      issue_id: 'far',
      profile_id: 'leo',
      subscribed: true,
    })
    // Me follows the task from the answer
    await press('[data-task-subscribe-me]')
    expect(writes('issues:subscribe')).toEqual([{ org_id: org, issue_id: 'far' }])
  })

  describe('in an organization of 1,000 people', () => {
    beforeAll(() => {
      crowd = 997
    })
    afterAll(() => {
      crowd = 0
    })

    it('finds and adds anyone of them, a batch at a time, by name or address', {
      timeout: 30_000,
    }, async () => {
      await showFromAnswer()
      // the store holds the signed-in person alone
      expect(P.users).toHaveLength(1)
      await press('[data-task-subscribe]')
      await press('[data-task-subscriber-add-open]')
      await vi.waitFor(() => expect(offered()).toHaveLength(25))
      // the portraits come from the rows, and name no one
      expect(
        document.querySelectorAll('[data-task-subscriber-candidates] [data-avatar]'),
      ).toHaveLength(0)
      expect(
        document.querySelectorAll('[data-task-subscriber-candidates] [data-row-avatar]'),
      ).toHaveLength(25)
      const field = search()
      if (!field) throw new Error('missing the search')
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          field,
          'Person 0996',
        )
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await vi.waitFor(() => expect(offered()).toEqual(['person-0996']))
      expect(candidateReads.at(-1)).toMatchObject({ search: 'Person 0996' })
      await press('[data-task-subscriber-add="person-0996"]')
      expect(writes('issues:setSubscriber')).toEqual([
        { org_id: org, issue_id: 'far', profile_id: 'person-0996', subscribed: true },
      ])
    })

    it('keeps the roster across a hidden page and reads it once on return', {
      timeout: 30_000,
    }, async () => {
      followers = ['aisha', 'leo']
      await showFromAnswer()
      await press('[data-task-subscribe]')
      await vi.waitFor(() => expect(listed()).toEqual(['aisha', 'leo']))
      const opened = rosterArgs.length
      expect(rosterOpen).toBe(1)
      await setVisibility('hidden')
      expect(rosterOpen).toBe(0)
      expect(listed()).toEqual(['aisha', 'leo'])
      holdRoster = true
      await setVisibility('visible')
      // one read on return, and the held roster, busy, while it runs
      expect(rosterArgs.length).toBe(opened + 1)
      expect(rosterOpen).toBe(1)
      expect(roster()?.getAttribute('aria-busy')).toBe('true')
      expect(listed()).toEqual(['aisha', 'leo'])
      expect(document.body.textContent).not.toContain('Loading subscribers')
      // add and remove stay open while it refreshes
      expect(
        document.querySelector<HTMLButtonElement>('[data-task-subscriber-remove="aisha"]')
          ?.disabled,
      ).toBe(false)
      followers = ['aisha']
      await act(async () => {
        for (const held of heldRoster) held.answer()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(roster()?.getAttribute('aria-busy')).toBeNull()
      expect(listed()).toEqual(['aisha'])
    })
  })
})

describe('the task subscribers popover while the page is hidden', () => {
  afterEach(() => {
    followers = []
  })

  it('reads nothing while closed, nor while hidden, and an opening starts from nothing', async () => {
    followers = ['aisha']
    await showFromAnswer()
    expect(rosterArgs).toEqual([])
    await setVisibility('hidden')
    await press('[data-task-subscribe]')
    expect(rosterArgs).toEqual([])
    expect(document.body.textContent).toContain('Loading subscribers')
    await setVisibility('visible')
    await vi.waitFor(() => expect(listed()).toEqual(['aisha']))
    // a close and an opening start over, with no roster until it answers
    await press('[data-task-subscribers-backdrop]')
    holdRoster = true
    await press('[data-task-subscribe]')
    expect(listed()).toEqual([])
    expect(roster()?.getAttribute('data-task-subscribers-roster') ?? null).toBeNull()
    expect(document.body.textContent).toContain('Loading subscribers')
  })

  it('says so when the roster fails', async () => {
    followers = ['aisha']
    holdRoster = true
    await showFromAnswer()
    await press('[data-task-subscribe]')
    await act(async () => {
      for (const held of heldRoster) held.fail(new Error('Server Error'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain(
      'Couldn’t load subscribers. Close and reopen to try again.',
    )
  })
})

describe('the task subscribers popover past the followers cap', () => {
  beforeAll(() => {
    crowd = 1
  })
  afterAll(() => {
    crowd = 0
    followers = []
  })

  it('lists the earliest followers and says the later ones show as earlier ones unfollow', async () => {
    // the cap lowered to 2, in the stand-in's limits and in the popover's,
    // which the store's modules loaded afresh
    const shown = (await import('../../convex/lib/limits')).LIMITS
    const cap = LIMITS.followers.max
    Object.assign(LIMITS.followers, { max: 2 })
    Object.assign(shown.followers, { max: 2 })
    try {
      // Person 0000 followed last, past the cap
      followers = ['leo', 'aisha', 'person-0000']
      await showFromAnswer()
      await press('[data-task-subscribe]')
      const listed = [...document.querySelectorAll('[data-task-subscriber]')].map((row) =>
        row.getAttribute('data-task-subscriber'),
      )
      expect(listed).toEqual(['aisha', 'leo'])
      expect(document.querySelector('[data-task-subscribers-more]')?.textContent).toBe(
        'Showing the 2 earliest followers. Later ones show here as earlier ones unfollow.',
      )
    } finally {
      Object.assign(LIMITS.followers, { max: cap })
      Object.assign(shown.followers, { max: cap })
    }
  })
})

describe('the task subscribers popover', () => {
  it('keeps the person search while it closes, and starts over when it opens', async () => {
    await showFromAnswer()
    await press('[data-task-subscribe]')
    await press('[data-task-subscriber-add-open]')
    const field = search()
    if (!field) throw new Error('missing the search')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        field,
        'leo@north',
      )
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // found by address, which the store does not hold
    await vi.waitFor(() => expect(offered()).toEqual(['leo']))
    // a click beside it closes the popover
    await press('[data-task-subscribers-backdrop]')
    expect(popover()?.getAttribute('data-state')).toBe('closed')
    expect(search()?.value).toBe('leo@north')
    expect(offered()).toEqual(['leo'])
    // the fading popover subscribes nobody
    const writes = network.mutation.mock.calls.length
    await press('[data-task-subscriber-add="leo"]')
    await act(async () => {
      document
        .querySelector('[data-task-subscriber-add="leo"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(network.mutation.mock.calls.length).toBe(writes)
    await endClosing()
    expect(popover()).toBeNull()
    await press('[data-task-subscribe]')
    expect(search()).toBeNull()
    await press('[data-task-subscriber-add-open]')
    expect(search()?.value).toBe('')
    await vi.waitFor(() => expect(offered()).toEqual(['aisha', 'leo']))
  })
})
