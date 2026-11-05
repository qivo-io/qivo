// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* An Inbox item whose task is still to arrive while a large workspace loads
   in stages (store/liveParts.ts): picking it reads its messages at once
   and opens its task in the pane from the server, by a reference with the
   message's organization (lib/taskReference.ts), and the pane's window
   stays the same window when the task arrives, or the home organization
   changes. Back or Forward to such a task (App pendingTask) shows the
   pane that says it loads, on a phone too, and Escape closes a pop-out,
   then the pane. A related task the workspace does not hold, opened from
   the pop-out, keeps both windows. */

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
/* The task window's reads of a task (taskWindow.task), which a test answers. */
let windowReads: { args: Record<string, unknown>; next: (value: unknown) => void }[]

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
async function loadingInbox(address: ((org: string) => string) | null = null) {
  vi.resetModules()
  windowReads = []
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
  network.onUpdate.mockImplementation((ref, args, next) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (name === 'taskWindow:task') windowReads.push({ args, next })
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
  // the task the pane shows now
  const shown = { open: null as string | null }
  /** The Inbox as App holds it: the task the pane shows is the address's,
      which follows its task's handle as it moves (P.watchHandles). */
  function Host() {
    usePlannerVersion()
    const [openIssue, setOpenIssue] = useState<string | null>(
      address ? address(snap.orgs[0].id) : null,
    )
    useEffect(() => {
      shown.open = openIssue
    }, [openIssue])
    useEffect(() => {
      go.to = setOpenIssue
      return store.P.watchHandles((moved) => setOpenIssue((cur) => (cur && moved.get(cur)) || cur))
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
  return { store, snap, opened, onExit, reads, goTo, current: () => shown.open }
}

/** Lets the last task window answer. */
const arrive = () =>
  act(async () => {
    double.live?.holdWindow(null)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

/* The task answer of fd000000-b, QN-2 (convex/lib/taskWindow.ts), with
   `subtasks`. */
const answerOf = (snap: Snapshot, subtasks: unknown[] = []) => {
  const row = snap.issues.find((it) => it.id === 'fd000000-b')
  return {
    state: 'ok',
    task: { ...row, has_subtasks: subtasks.length > 0 },
    level: 'user',
    labels: [],
    follow: null,
    parent: null,
    subtasks: { rows: subtasks, complete: true },
  }
}
/* The pane's window. */
const paneWindow = () => container.querySelector<HTMLElement>('.inbox-detail-frame [role="region"]')

describe('an Inbox item whose task is still to arrive', { timeout: 20_000 }, () => {
  it('reads its messages when picked, opens its task in the pane from the server, and keeps the same window once it arrives', async () => {
    const { store, snap, opened, reads, current } = await loadingInbox()
    const open = container.querySelector<HTMLButtonElement>(
      '[data-message="fd000000-b"] .inbox-message-open',
    )
    await act(async () => open?.click())
    const org = snap.orgs[0].id
    expect(reads()[0]?.[1]).toEqual({ org_id: org, ids: ['message-a'] })
    // by a reference with the message's organization and the task's uuid
    const { refParts } = await import('../lib/taskReference')
    expect(refParts(opened.at(-1))).toEqual({ org, uuid: 'fd000000-b' })
    expect(container.querySelector('[data-task-loading]')?.textContent).toContain(
      'Loading this task…',
    )
    expect(windowReads.map((read) => read.args)).toEqual([{ org_id: org, ref: 'fd000000-b' }])
    await act(async () => windowReads[0]?.next(answerOf(snap)))
    await vi.waitFor(() => expect(paneWindow()?.textContent).toContain('Run the soak test'))
    expect(paneWindow()?.dataset.taskSource).toBe('answer')
    const pane = paneWindow()
    // the reference turns into the task's handle as the task arrives, and
    // the pane's window stays
    await arrive()
    expect(store.P.stillLoading()).toBeNull()
    expect(current()).toBe(store.P.handleOf('fd000000-b'))
    expect(paneWindow()).toBe(pane)
    expect(paneWindow()?.dataset.taskSource).toBe('workspace')
  })

  it('keeps both windows when the pop-out opens a related task the workspace does not hold', async () => {
    const { store, snap } = await loadingInbox()
    const open = container.querySelector<HTMLButtonElement>(
      '[data-message="00000000-a"] .inbox-message-open',
    )
    await act(async () => open?.click())
    const popOut = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[data-task-popout]')
      if (!button) throw new Error('missing the pop-out button')
      return button
    })
    await act(async () => popOut.click())
    // the pop-out reads the held task's subtasks, one still to arrive
    const kid = snap.issues.find((it) => it.id === 'fd000000-b')
    const {
      description: _text,
      has_hidden_subtasks: _h,
      has_hidden_parent: _p,
      ...short
    } = kid ?? {}
    const held = snap.issues.find((it) => it.id === '00000000-a')
    await vi.waitFor(() => expect(windowReads.length).toBeGreaterThan(0))
    await act(async () =>
      windowReads.at(-1)?.next({
        ...answerOf(snap),
        task: { ...held, has_subtasks: true },
        subtasks: {
          rows: [{ ...short, parent_id: '00000000-a', has_subtasks: false, level: 'user' }],
          complete: true,
        },
      }),
    )
    const related = await vi.waitFor(() => {
      const row = document.querySelector<HTMLButtonElement>('[data-related-task] button')
      if (!row) throw new Error('missing the related row')
      return row
    })
    await act(async () => related.click())
    // both windows stay, on the related task, which loads from the server
    expect(store.P.handleOf('fd000000-b')).toBeNull()
    expect(document.querySelector('[data-task-scrim]')).not.toBeNull()
    expect(paneWindow()).not.toBeNull()
    expect(container.querySelector('.inbox-detail-frame [data-task-loading]')).not.toBeNull()
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
    const { taskRef } = await import('../lib/taskReference')
    const { opened } = await loadingInbox((org) => taskRef({ org, num: 2 }))
    expect(container.querySelector('[data-inbox]')?.hasAttribute('data-inbox-mobile-detail')).toBe(
      true,
    )
    expect(container.querySelector('[data-task-loading]')?.textContent).toContain('Loading QN-2…')
    // the window's own Close
    const back = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Close')
    await act(async () => back?.click())
    expect(opened).toEqual([null])
    expect(container.querySelector('[data-inbox]')?.hasAttribute('data-inbox-mobile-detail')).toBe(
      false,
    )
  })

  it('closes the pane on Escape before it leaves the Inbox', async () => {
    const { taskRef } = await import('../lib/taskReference')
    const { opened, onExit } = await loadingInbox((org) => taskRef({ org, num: 2 }))
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

  it('closes the pop-out, then the pane, on Escape, also over a task still to arrive', async () => {
    const { store, snap, opened, goTo } = await loadingInbox()
    const task = store.P.issues.find((it) => it.uuid === '00000000-a')
    await goTo(task?.id ?? null)
    const popOut = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[data-task-popout]')
      if (!button) throw new Error('missing the pop-out button')
      return button
    })
    await act(async () => popOut.click())
    expect(document.querySelector('[data-task-scrim]')).not.toBeNull()
    // Back to a task still to arrive, which both windows follow
    const { taskRef } = await import('../lib/taskReference')
    await goTo(taskRef({ org: snap.orgs[0].id, num: 2 }))
    expect(container.querySelector('[data-task-loading]')).not.toBeNull()
    expect(document.querySelector('[data-task-scrim]')).not.toBeNull()
    const pressEscape = () =>
      act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      })
    // the pop-out first, then the pane
    await pressEscape()
    expect(document.querySelector('[data-task-scrim]')).toBeNull()
    expect(container.querySelector('[data-task-loading]')).not.toBeNull()
    expect(opened).toEqual([])
    await pressEscape()
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
