// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* An Inbox item whose task is still to arrive while a large workspace loads
   in stages (store/liveParts.ts): picking it reads nothing yet, and the
   task opens in the pane once it arrives, its item read then. Back or
   Forward to such a task (App pendingTask) shows the pane that says so,
   on a phone too, and Escape closes that pane first, with any pop-out
   left from the task before. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | { holdWindow(from: string | null): void },
}))
vi.mock('../lib/convex', async () => {
  const { liveOver } = await import('../store/guard/liveDouble.setup')
  double.live = liveOver(network)
  return { convex: network, live: double.live }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const AT = '2026-09-14T08:00:00.000Z'
// 12,800 task numbers make 64 task windows; the last starts at fc000000
const LAST_WINDOW = 'fc000000'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  double.live?.holdWindow(null)
  container.remove()
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Loads a large workspace whose last task window, holding task QN-2 and
    its Inbox item, is still to arrive, and renders the Inbox as App holds
    it, the pane showing the task the address names, `address` at first.
    Answers the store, the fixture, the tasks the Inbox opened, its exits,
    its reads and a way to move the address as Back or Forward would. */
async function loadingInbox(address: string | null = null) {
  vi.resetModules()
  const snap: Snapshot = plannerFixture()
  snap.orgs[0].next_issue_num = 64 * 200
  snap.issues.push({
    id: 'fd000000-b',
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
    num: 2,
    title: 'Run the soak test',
    description: '',
    status: 'progress',
    priority: 'medium',
    paused: false,
    created_at: AT,
    updated_at: AT,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  // a task in the first stage's windows, which have loaded, with its own item
  snap.issues.push({
    id: '00000000-a',
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
    num: 1,
    title: 'Write the load plan',
    description: '',
    status: 'todo',
    priority: 'medium',
    paused: false,
    created_at: AT,
    updated_at: AT,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  snap.messages.push({
    id: 'message-b',
    org_id: snap.orgs[0].id,
    recipient_id: snap.profiles[0].id,
    issue_id: '00000000-a',
    issue_title: 'Write the load plan',
    kind: 'comment',
    detail: 'New comment',
    created_at: '2026-09-14T08:30:00.000Z',
  })
  snap.messages.push({
    id: 'message-a',
    org_id: snap.orgs[0].id,
    recipient_id: snap.profiles[0].id,
    issue_id: 'fd000000-b',
    issue_title: 'Run the soak test',
    kind: 'comment',
    detail: 'New comment',
    created_at: '2026-09-14T09:00:00.000Z',
  })
  network.onUpdate.mockImplementation((ref, _args, next) => {
    if (getFunctionName(ref) === 'workspace:whole') next(structuredClone(snap))
    return () => {}
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  const reads = () =>
    network.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === 'messages:markRead')
  const store = await import('../store/planner')
  double.live?.holdWindow(LAST_WINDOW)
  await store.initStore()
  expect(store.P.stillLoading()).not.toBeNull()
  const { Inbox } = await import('./Inbox')
  const { usePlannerVersion } = await import('../store/usePlannerVersion')
  const opened: (string | null)[] = []
  const onExit = vi.fn()
  const go = { to: (_handle: string | null) => {} }
  /** The Inbox as App holds it: the task the pane shows is the address's. */
  function Host() {
    usePlannerVersion()
    const [openIssue, setOpenIssue] = useState<string | null>(address)
    useEffect(() => {
      go.to = setOpenIssue
    }, [])
    return (
      <Inbox
        showOnBoard={vi.fn()}
        onExit={onExit}
        openTask={(handle: string | null) => {
          opened.push(handle)
          setOpenIssue(handle)
        }}
        openIssue={openIssue}
        onPlanOnRoadmap={vi.fn()}
      />
    )
  }
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Host />
      </TooltipProvider>,
    ),
  )
  const goTo = (handle: string | null) => act(async () => go.to(handle))
  return { store, snap, opened, onExit, reads, goTo }
}

/** Lets the last task window answer. */
const arrive = () =>
  act(async () => {
    double.live?.holdWindow(null)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

describe('an Inbox item whose task is still to arrive', { timeout: 20_000 }, () => {
  it('reads nothing when picked, and opens its task once it arrives', async () => {
    const { store, snap, opened, reads } = await loadingInbox()
    const open = container.querySelector<HTMLButtonElement>(
      '[data-message="fd000000-b"] .inbox-message-open',
    )
    await act(async () => open?.click())
    expect(reads()).toHaveLength(0)
    expect(container.textContent).toContain('This task is still loading.')

    await arrive()
    expect(store.P.stillLoading()).toBeNull()
    const task = store.P.issues.find((it) => it.uuid === 'fd000000-b')
    expect(opened.at(-1)).toBe(task?.id)
    expect(reads()[0]?.[1]).toEqual({ org_id: snap.orgs[0].id, ids: ['message-a'] })
  })
})

describe('the Inbox at a task still to arrive', { timeout: 20_000 }, () => {
  it('shows the pane that says so on a phone, with Back to inbox', async () => {
    // only the phone breakpoint matches
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(max-width: 760px)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
    const { opened } = await loadingInbox('qn-2')
    expect(container.querySelector('[data-inbox]')?.hasAttribute('data-inbox-mobile-detail')).toBe(
      true,
    )
    expect(container.querySelector('[data-task-loading]')).not.toBeNull()
    const back = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Back to inbox',
    )
    await act(async () => back?.click())
    expect(opened).toEqual([null])
    expect(container.querySelector('[data-inbox]')?.hasAttribute('data-inbox-mobile-detail')).toBe(
      false,
    )
  })

  it('closes the pane on Escape before it leaves the Inbox', async () => {
    const { opened, onExit } = await loadingInbox('qn-2')
    expect(container.querySelector('[data-task-loading]')).not.toBeNull()
    const pressEscape = () =>
      act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      })
    await pressEscape()
    expect(opened).toEqual([null])
    expect(onExit).not.toHaveBeenCalled()
    expect(container.querySelector('[data-task-loading]')).toBeNull()
    await pressEscape()
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('closes a pop-out left from the task before when Escape closes the pane', async () => {
    const { store, opened, goTo } = await loadingInbox()
    const task = store.P.issues.find((it) => it.uuid === '00000000-a')
    await goTo(task?.id ?? null)
    const popOut = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[data-task-popout]')
      if (!button) throw new Error('missing the pop-out button')
      return button
    })
    await act(async () => popOut.click())
    expect(document.querySelector('[data-task-scrim]')).not.toBeNull()
    // Back to a task still to arrive, which leaves the pop-out
    await goTo('qn-2')
    expect(container.querySelector('[data-task-loading]')).not.toBeNull()
    expect(document.querySelector('[data-task-scrim]')).toBeNull()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(opened).toEqual([null])
    // the next item opens in the pane, not in a pop-out
    const open = container.querySelector<HTMLButtonElement>(
      '[data-message="00000000-a"] .inbox-message-open',
    )
    await act(async () => open?.click())
    expect(opened.at(-1)).toBeTruthy()
    expect(container.querySelector('[data-task-popout]')).not.toBeNull()
    expect(document.querySelector('[data-task-scrim]')).toBeNull()
  })
})
