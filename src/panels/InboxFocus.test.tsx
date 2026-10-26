// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* Where keyboard focus goes in the Inbox when a row leaves the list: after
   the pane's Archive or delete window takes its task away, after a row's
   own menu removes or snoozes it, and after that menu or the toolbar acts
   on the whole list. On the real store, at desktop width unless a test
   takes a phone's, with the server answering every write at once unless a
   test holds it. */

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

const AT = Date.parse('2026-09-14T08:00:00.000Z')

let container: HTMLDivElement
let root: Root
let snap: Snapshot
let onClose: ReturnType<typeof vi.fn<() => void>>

/* Renders the Inbox as App holds it with `count` tasks, one item each,
   listed task-0 first (the newest), and the pane on task `shown`, if any.
   The items of the tasks `read` are read. Answers the task uuids in list
   order. */
async function openInbox(count: number, shown: number | null = null, read: number[] = []) {
  vi.resetModules()
  snap = plannerFixture()
  const uuids: string[] = []
  for (let n = 0; n < count; n++) {
    const uuid = `task-${n}`
    uuids.push(uuid)
    snap.issues.push({
      id: uuid,
      org_id: snap.orgs[0].id,
      project_id: snap.projects[0].id,
      num: n + 1,
      title: `Task ${n}`,
      description: '',
      status: 'progress',
      priority: 'medium',
      paused: false,
      created_at: new Date(AT).toISOString(),
      updated_at: new Date(AT).toISOString(),
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    snap.messages.push({
      id: `message-${n}`,
      org_id: snap.orgs[0].id,
      recipient_id: snap.profiles[0].id,
      issue_id: uuid,
      issue_title: `Task ${n}`,
      kind: 'comment',
      detail: 'New comment',
      created_at: new Date(AT - n * 60_000).toISOString(),
      ...(read.includes(n) ? { read_at: new Date(AT).toISOString() } : {}),
    })
  }
  network.onUpdate.mockImplementation((ref, _args, next) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (name === 'snapshot:commentThread') next({ comments: [], earlier: false, events: [] })
    return () => {}
  })
  network.query.mockReset()
  network.query.mockResolvedValue(null)
  network.mutation.mockReset()
  network.mutation.mockResolvedValue(null)
  const store = await import('../store/planner')
  await store.initStore()
  const handle = (n: number) => store.P.issues.find((it) => it.uuid === uuids[n])?.id ?? null
  const { Inbox } = await import('./Inbox')
  const { usePlannerVersion } = await import('../store/usePlannerVersion')
  onClose = vi.fn<() => void>()
  /** The Inbox as App holds it, its pane on the task the address names. */
  function InboxHost() {
    usePlannerVersion()
    const [openIssue, setOpenIssue] = useState<string | null>(shown === null ? null : handle(shown))
    return (
      <Inbox
        showOnBoard={vi.fn()}
        onExit={vi.fn()}
        openTask={(next: string | null) => {
          if (next === null) onClose()
          setOpenIssue(next)
        }}
        openIssue={openIssue}
        onPlanOnRoadmap={vi.fn()}
      />
    )
  }
  await act(async () =>
    root.render(
      <TooltipProvider>
        <InboxHost />
      </TooltipProvider>,
    ),
  )
  return uuids
}

/** Focuses `element`, as a press or Tab does, and clicks it. */
async function press(element: HTMLElement | null | undefined) {
  if (!element) throw new Error('nothing to press')
  await act(async () => {
    element.focus()
    element.click()
  })
}

/** Lets the timers the closing layers queued run. */
const settle = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 20)))

/** What has focus: a row's open button, by its task, the search field,
    the page, or else the element's start. */
function focused() {
  const element = document.activeElement
  if (!element || element === document.body) return 'the page'
  const row = element.closest<HTMLElement>('[data-message]')
  if (row && element.matches('.inbox-message-open')) return `row ${row.dataset.message}`
  if (element.matches('[data-inbox-search]')) return 'the search field'
  if (element.matches('[data-inbox-empty]')) return 'the empty list'
  return element.outerHTML.slice(0, 120)
}

const rowOpen = (uuid: string) =>
  document.querySelector<HTMLElement>(`[data-message="${uuid}"] .inbox-message-open`)
/** The Archive or delete window's submit button for `fate`. */
const submit = (fate: 'Archive' | 'Delete') =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-modal-shell] button')].find((b) =>
    fate === 'Archive' ? b.textContent === 'Archive' : b.textContent?.startsWith('Delete '),
  )

/* Archives or deletes the pane's task through its Archive or delete window,
   with the keyboard focus a person's presses leave, and waits for the pane
   to close. */
async function leaveFromPane(fate: 'Archive' | 'Delete') {
  await press(document.querySelector<HTMLElement>('[aria-label="Task actions"]'))
  await press(document.querySelector<HTMLElement>('[data-task-fate]'))
  if (fate === 'Delete')
    await press(
      document.querySelector<HTMLElement>('[data-fate-card="delete"] input[type="radio"]'),
    )
  const reason = document.querySelector<HTMLTextAreaElement>('[data-fate-reason]')
  if (!reason) throw new Error('the Archive or delete window did not open')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      reason,
      'Done elsewhere',
    )
    reason.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await press(submit(fate))
  await act(async () => {
    await vi.waitFor(() => {
      if (!onClose.mock.calls.length) throw new Error('the pane has not closed yet')
    })
  })
  await settle()
}

/** A write the test answers or refuses. */
type Held = { answer: (value: unknown) => void; refuse: (error: Error) => void }

/** Takes a phone's width: only the phone breakpoint matches. */
function onPhone() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === '(max-width: 760px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}

/** Opens the row menu of `uuid`'s row from its open button, as the context
    menu key or a right click does. */
async function openRowMenu(uuid: string) {
  const open = rowOpen(uuid)
  if (!open) throw new Error('no such row')
  await act(async () => {
    open.focus()
    open.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  if (!document.querySelector('[data-msg-menu]')) throw new Error('the row menu did not open')
}

beforeEach(() => {
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Inbox focus when a row leaves', { timeout: 20_000 }, () => {
  it("gives focus to the next row after the pane's window archives its task", async () => {
    const uuids = await openInbox(3, 1)
    await leaveFromPane('Archive')
    expect(rowOpen(uuids[1])).toBeNull()
    expect(focused()).toBe(`row ${uuids[2]}`)
  })

  it("gives focus to the search field after the pane's window deletes the only task", async () => {
    await openInbox(1, 0)
    await leaveFromPane('Delete')
    expect(document.querySelector('[data-message]')).toBeNull()
    expect(focused()).toBe('the search field')
  })

  it('gives focus to the row in its place after its menu removes it', async () => {
    const uuids = await openInbox(3)
    await openRowMenu(uuids[0])
    const remove = [...document.querySelectorAll<HTMLElement>('[data-msg-menu] button')].find(
      (b) => b.textContent === 'Remove notification',
    )
    await press(remove)
    await settle()
    expect(rowOpen(uuids[0])).toBeNull()
    expect(focused()).toBe(`row ${uuids[1]}`)
  })

  it('gives focus to the first row still listed after the row menu removes all read', async () => {
    const uuids = await openInbox(3, null, [0])
    network.mutation.mockImplementation(async (ref) =>
      getFunctionName(ref) === 'messages:removeRead'
        ? { ids: ['message-0'], hasMore: false }
        : null,
    )
    await openRowMenu(uuids[2])
    await press(document.querySelector<HTMLElement>('[data-msg-menu-remove-read]'))
    await settle()
    expect(rowOpen(uuids[0])).toBeNull()
    expect(focused()).toBe(`row ${uuids[1]}`)
  })

  /* Runs the toolbar's Mark all as read with the server's answer held, and
     settles it with `settleWrite` once focus left the button. A browser
     takes focus from the button as it disables itself; jsdom keeps it there
     and will not blur a disabled button, so focus goes to a stand-in that
     then leaves: focus is nowhere while the write runs, as in a browser. */
  async function markAllReadFromToolbar(settleWrite: (held: Held) => void) {
    let held: Held = { answer: () => {}, refuse: () => {} }
    network.mutation.mockImplementation((ref) =>
      getFunctionName(ref) === 'messages:markAllRead'
        ? new Promise((answer, refuse) => {
            held = { answer, refuse }
          })
        : Promise.resolve(null),
    )
    const button = document.querySelector<HTMLButtonElement>('[data-inbox-mark-all-read]')
    await press(button)
    expect(button?.disabled).toBe(true)
    await act(async () => {
      const standIn = document.body.appendChild(document.createElement('button'))
      standIn.focus()
      standIn.remove()
    })
    expect(document.activeElement).toBe(document.body)
    await act(async () => settleWrite(held))
    await settle()
    return button
  }

  it('gives focus back to the toolbar button once its refused action ends', async () => {
    await openInbox(3)
    const button = await markAllReadFromToolbar((held) => held.refuse(new Error('offline')))
    expect(button?.disabled).toBe(false)
    expect(document.activeElement).toBe(button)
  })

  it('gives focus to the first row after the toolbar button stays disabled', async () => {
    const uuids = await openInbox(3)
    const button = await markAllReadFromToolbar((held) =>
      held.answer({ ids: ['message-0', 'message-1', 'message-2'], hasMore: false }),
    )
    expect(button?.disabled).toBe(true)
    expect(focused()).toBe(`row ${uuids[0]}`)
  })

  it("gives focus to the empty list's line on a phone after the task window deletes the only task", async () => {
    onPhone()
    await openInbox(1, 0)
    expect(document.querySelector('[data-inbox-search]')).toBeNull()
    // the window takes focus a frame after it opens, which would close a
    // menu opened before
    await act(async () => {
      await vi.waitFor(() => {
        if (!document.activeElement?.matches('[data-mobile-task-back]'))
          throw new Error('the window has no focus yet')
      })
    })
    await leaveFromPane('Delete')
    expect(focused()).toBe('the empty list')
  })

  it("gives focus to the empty list's line on a phone after the row menu removes the last row", async () => {
    onPhone()
    const [uuid] = await openInbox(1)
    expect(document.querySelector('[data-inbox-search]')).toBeNull()
    await press(document.querySelector<HTMLElement>('.inbox-message-actions'))
    const remove = [...document.querySelectorAll<HTMLElement>('[data-msg-menu] button')].find(
      (b) => b.textContent === 'Remove notification',
    )
    await press(remove)
    await settle()
    expect(rowOpen(uuid)).toBeNull()
    expect(focused()).toBe('the empty list')
  })

  it('gives focus to the row before it after its menu snoozes the last row', async () => {
    const uuids = await openInbox(3)
    await openRowMenu(uuids[2])
    await press(document.querySelector<HTMLElement>('[data-msg-snooze-go]'))
    await settle()
    expect(rowOpen(uuids[2])).toBeNull()
    expect(focused()).toBe(`row ${uuids[1]}`)
  })
})
