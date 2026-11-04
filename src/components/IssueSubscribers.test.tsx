// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { endClosing, playClosingAnimations } from '../lib/closingAnimation.setup'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'
import { TooltipProvider } from './ui/tooltip'

/* A task's subscribers popover on the real store as it closes. A close
   leaves the person search as it was, so the closing popover keeps what it
   showed open but takes no press, and the next opening starts over. Aisha
   and Leo may be added; nobody follows the task yet. */

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

type Planner = typeof import('../store/planner')['P']
const NOW = '2026-09-14T08:00:00.000Z'

let P: Planner
let ui: typeof import('./IssueSubscribers')
let container: HTMLDivElement
let root: Root
let org: string
/* How many more people the organization holds than Aisha and Leo, and who
   follows the task besides, as the roster answers. */
let crowd = 0
let followers: string[] = []
/* The roster's arguments, and the window's read of a task the workspace
   does not hold. */
let rosterArgs: Record<string, unknown>[] = []
let windowRead: ((value: unknown) => void) | null = null

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
  const snap: Snapshot = plannerFixture()
  org = snap.orgs[0].id
  const me = snap.profiles[0]
  for (const [id, name] of [
    ['aisha', 'Aisha Rahman'],
    ['leo', 'Leo Martins'],
  ])
    snap.profiles.push({ ...me, id, name, auth_user_id: `account-${id}` })
  for (let i = 0; i < crowd; i++) {
    const id = `person-${String(i).padStart(4, '0')}`
    snap.profiles.push({ ...me, id, name: `Person ${id.slice(7)}`, auth_user_id: `account-${id}` })
  }
  rosterArgs = []
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
  network.onUpdate.mockImplementation((ref, args, next) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    if (name === 'taskWindow:task') windowRead = next
    if (name === 'issues:subscribers') {
      rosterArgs.push(args)
      next({
        canManage: true,
        subscribers: followers,
        candidates: snap.profiles
          .map((p) => p.id)
          .filter((id) => id !== me.id && !followers.includes(id)),
      })
    }
    return () => {}
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  const store = await import('../store/planner')
  P = store.P
  await store.initStore()
  ui = await import('./IssueSubscribers')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const issue = P.issues.find((it) => it.uuid === 'task-a')
  if (!issue) throw new Error('missing the task')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ui.IssueSubscribers issue={issue} />
      </TooltipProvider>,
    ),
  )
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const popover = () => document.querySelector('[data-task-subscribers]')
const search = () => document.querySelector<HTMLInputElement>('[data-task-subscriber-search]')
const offered = () =>
  [...document.querySelectorAll('[data-task-subscriber-add]')].map((row) =>
    row.getAttribute('data-task-subscriber-add'),
  )
const press = (selector: string) =>
  act(async () => document.querySelector<HTMLElement>(selector)?.click())

/* Renders the popover for task QN-40, which the workspace does not hold,
   from the window's own answer of it (P.taskDetail). */
async function showFromAnswer() {
  network.mutation.mockClear()
  P.watchComments('far', org)
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  const task = {
    id: 'far',
    org_id: org,
    project_id: P.projects[0].id,
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

    it('finds and adds anyone of them', { timeout: 30_000 }, async () => {
      await showFromAnswer()
      expect(P.users).toHaveLength(1000)
      await press('[data-task-subscribe]')
      await press('[data-task-subscriber-add-open]')
      expect(offered()).toHaveLength(999)
      const field = search()
      if (!field) throw new Error('missing the search')
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          field,
          'Person 0996',
        )
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(offered()).toEqual(['person-0996'])
      await press('[data-task-subscriber-add="person-0996"]')
      expect(writes('issues:setSubscriber')).toEqual([
        { org_id: org, issue_id: 'far', profile_id: 'person-0996', subscribed: true },
      ])
    })
  })
})

describe('the task subscribers popover', () => {
  it('keeps the person search while it closes, and starts over when it opens', async () => {
    await press('[data-task-subscribe]')
    await press('[data-task-subscriber-add-open]')
    const field = search()
    if (!field) throw new Error('missing the search')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'Le')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(offered()).toEqual(['leo'])
    // a click beside it closes the popover
    await press('[data-task-subscribers-backdrop]')
    expect(popover()?.getAttribute('data-state')).toBe('closed')
    expect(search()?.value).toBe('Le')
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
    expect(offered()).toEqual(['aisha', 'leo'])
  })
})
