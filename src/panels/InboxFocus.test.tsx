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
/* What messages.bulkReach answers the seat: `one` batch when it holds a
   row the action walks, unless a test sets `reach`. It waits for
   `reachGate` when a test sets one. */
let reach: 'one' | 'many' | null
let reachGate: Promise<void> | null
/* Shows or hides the Inbox's kept view, for an Inbox opened `kept`. */
let showKept: (shown: boolean) => void
/* The Inbox's onExit, which Escape calls once nothing else takes it. */
let onExit: ReturnType<typeof vi.fn<() => void>>

/* Renders the Inbox as App holds it with `count` tasks, one item each,
   listed task-0 first (the newest), and the pane on task `shown`, if any.
   The items of the tasks `read` are read. Answers the task uuids in list
   order. */
async function openInbox(
  count: number,
  shown: number | null = null,
  read: number[] = [],
  { kept = false } = {},
) {
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
    else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    return () => {}
  })
  network.query.mockReset()
  network.query.mockImplementation(async (ref, args) => {
    if (getFunctionName(ref) !== 'messages:bulkReach') return null
    if (reachGate) await reachGate
    const walked = snap.messages.some((m) => !!m.read_at === (args.action === 'remove'))
    return {
      seats: snap.orgs.map((org) => ({
        org_id: org.id,
        reach: reach ?? (walked ? 'one' : 'none'),
        before: 1,
      })),
    }
  })
  network.mutation.mockReset()
  network.mutation.mockResolvedValue(null)
  const store = await import('../store/planner')
  await store.initStore()
  const handle = (n: number) => store.P.issues.find((it) => it.uuid === uuids[n])?.id ?? null
  const { Inbox } = await import('./Inbox')
  const { usePlannerVersion } = await import('../store/usePlannerVersion')
  const { KeptView } = await import('../components/KeptView')
  onClose = vi.fn<() => void>()
  onExit = vi.fn<() => void>()
  /** The Inbox as App holds it, its pane on the task the address names. */
  function InboxHost() {
    usePlannerVersion()
    const [openIssue, setOpenIssue] = useState<string | null>(shown === null ? null : handle(shown))
    return (
      <Inbox
        showOnBoard={vi.fn()}
        onExit={onExit}
        openTask={(next: string | null) => {
          if (next === null) onClose()
          setOpenIssue(next)
        }}
        openIssue={openIssue}
        onPlanOnRoadmap={vi.fn()}
      />
    )
  }
  /** The Inbox in a kept view, as App keeps it beside the other pages. */
  function KeptHost() {
    const [shown, setShown] = useState(true)
    showKept = setShown
    return (
      <KeptView view="inbox" shown={shown} className="view">
        <InboxHost />
      </KeptView>
    )
  }
  await act(async () =>
    root.render(<TooltipProvider>{kept ? <KeptHost /> : <InboxHost />}</TooltipProvider>),
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
  reach = null
  reachGate = null
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

/** The writes of Mark all as read the test holds, in the order sent. */
function holdMarkAllRead() {
  const held: Held[] = []
  network.mutation.mockImplementation((ref) =>
    getFunctionName(ref) === 'messages:markAllRead'
      ? new Promise((answer, refuse) => held.push({ answer, refuse }))
      : Promise.resolve(null),
  )
  return held
}

const markAllButton = () => document.querySelector<HTMLButtonElement>('[data-inbox-mark-all-read]')
const notice = () => document.querySelector<HTMLElement>('[data-inbox-notice]')
const progress = () => document.querySelector<HTMLElement>('[data-inbox-progress]')
const sentMarks = () =>
  network.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === 'messages:markAllRead')

describe('Inbox bulk actions that take more than one round', { timeout: 20_000 }, () => {
  it('asks first, sends nothing on Cancel and gives focus back to the button', async () => {
    await openInbox(3)
    reach = 'many'
    holdMarkAllRead()
    await press(markAllButton())
    await settle()
    expect(notice()?.textContent).toContain('Keep Qivo open')
    expect(notice()?.textContent).toContain(
      'Mark all as read covers many messages and runs in steps. Keep Qivo open until it finishes. Closing or reloading Qivo stops it, and the steps already done stay done.',
    )
    // the buttons wait for the answer, and nothing is sent or painted
    expect(markAllButton()?.disabled).toBe(true)
    expect(sentMarks()).toEqual([])
    expect(document.querySelectorAll('[data-message][data-unread]').length).toBe(
      document.querySelectorAll('[data-message]').length,
    )
    await press(document.querySelector<HTMLElement>('[data-inbox-notice-cancel]'))
    await settle()
    expect(notice()).toBeNull()
    expect(sentMarks()).toEqual([])
    expect(markAllButton()?.disabled).toBe(false)
    expect(document.activeElement).toBe(markAllButton())
  })

  it('gives focus to the first row after Cancel when the row menu opened the notice', async () => {
    const uuids = await openInbox(3)
    reach = 'many'
    await openRowMenu(uuids[2])
    await press(document.querySelector<HTMLElement>('[data-msg-menu-mark-all-read]'))
    await settle()
    expect(notice()).not.toBeNull()
    await press(document.querySelector<HTMLElement>('[data-inbox-notice-cancel]'))
    await settle()
    expect(sentMarks()).toEqual([])
    expect(focused()).toBe(`row ${uuids[0]}`)
  })

  it('shows its progress with every action disabled once confirmed, also in an Inbox mounted again', async () => {
    const uuids = await openInbox(3)
    reach = 'many'
    const held = holdMarkAllRead()
    await press(markAllButton())
    await settle()
    expect(progress()?.textContent).toBe('')
    await press(document.querySelector<HTMLElement>('[data-inbox-notice-confirm]'))
    await settle()
    expect(notice()).toBeNull()
    expect(sentMarks()).toHaveLength(1)
    expect(progress()?.getAttribute('aria-live')).toBe('polite')
    expect(progress()?.textContent).toBe('Marking messages read, 0 done')
    await act(async () =>
      held[0].answer({ marked: 2, ids: ['message-0', 'message-1'], hasMore: true, before: 1 }),
    )
    await settle()
    expect(progress()?.textContent).toBe('Marking messages read, 2 done')
    expect(markAllButton()?.disabled).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[data-inbox-remove-read]')?.disabled).toBe(
      true,
    )
    await openRowMenu(uuids[2])
    for (const item of ['[data-msg-menu-mark-all-read]', '[data-msg-menu-remove-read]'])
      expect(document.querySelector<HTMLButtonElement>(item)?.disabled).toBe(true)
    // leaving the Inbox and coming back keeps the action and its progress
    const { Inbox } = await import('./Inbox')
    await act(async () => root.render(<TooltipProvider>{null}</TooltipProvider>))
    expect(progress()).toBeNull()
    await act(async () =>
      root.render(
        <TooltipProvider>
          <Inbox
            showOnBoard={vi.fn()}
            onExit={vi.fn()}
            openTask={vi.fn()}
            openIssue={null}
            onPlanOnRoadmap={vi.fn()}
          />
        </TooltipProvider>,
      ),
    )
    expect(progress()?.textContent).toBe('Marking messages read, 2 done')
    await vi.waitFor(() => expect(held).toHaveLength(2))
    await act(async () =>
      held[1].answer({ marked: 1, ids: ['message-2'], hasMore: false, before: 1 }),
    )
    await settle()
    expect(progress()?.textContent).toBe('')
    expect(window.showToast).toHaveBeenCalledWith('Marked 3 messages as read.', 'success')
  })

  it('closes the notice on Escape, sends nothing, keeps the Inbox and gives focus back', async () => {
    await openInbox(3)
    reach = 'many'
    await press(markAllButton())
    await settle()
    expect(notice()).not.toBeNull()
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
    })
    await settle()
    expect(notice()).toBeNull()
    expect(sentMarks()).toEqual([])
    expect(onExit).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(markAllButton())
  })

  it('runs from the row menu after Confirm and gives focus to the first row still listed', async () => {
    const uuids = await openInbox(3)
    reach = 'many'
    const held = holdMarkAllRead()
    await openRowMenu(uuids[2])
    await press(document.querySelector<HTMLElement>('[data-msg-menu-mark-all-read]'))
    await settle()
    expect(notice()).not.toBeNull()
    // the menu that opened it is gone
    expect(document.querySelector('[data-msg-menu]')).toBeNull()
    await press(document.querySelector<HTMLElement>('[data-inbox-notice-confirm]'))
    await settle()
    expect(notice()).toBeNull()
    expect(sentMarks()).toHaveLength(1)
    expect(focused()).toBe(`row ${uuids[0]}`)
    await act(async () =>
      held[0].answer({ marked: 3, ids: ['message-0', 'message-1', 'message-2'], hasMore: false }),
    )
    await settle()
    expect(progress()?.textContent).toBe('')
    expect(focused()).toBe(`row ${uuids[0]}`)
  })

  it('gives focus back once an action answered before the notice finished closing', async () => {
    const uuids = await openInbox(3)
    reach = 'many'
    // every batch answers at once, so the action ends as the notice closes
    network.mutation.mockImplementation(async (ref) =>
      getFunctionName(ref) === 'messages:markAllRead'
        ? { marked: 3, ids: ['message-0', 'message-1', 'message-2'], hasMore: false, before: 1 }
        : null,
    )
    await press(markAllButton())
    await settle()
    await press(document.querySelector<HTMLElement>('[data-inbox-notice-confirm]'))
    await settle()
    expect(notice()).toBeNull()
    expect(window.showToast).toHaveBeenCalledWith('Marked 3 messages as read.', 'success')
    // the button stays disabled with nothing unread, so the first row has it
    expect(markAllButton()?.disabled).toBe(true)
    expect(focused()).toBe(`row ${uuids[0]}`)
  })

  it('gives focus to the first row at once after a row menu press, before bulkReach answers', async () => {
    const uuids = await openInbox(3)
    let open: () => void = () => {}
    reachGate = new Promise((resolve) => {
      open = resolve
    })
    await openRowMenu(uuids[2])
    await press(document.querySelector<HTMLElement>('[data-msg-menu-mark-all-read]'))
    await settle()
    expect(focused()).toBe(`row ${uuids[0]}`)
    await act(async () => open())
    await settle()
  })

  it('does not open the notice over a field the person types in, and ends the action', async () => {
    await openInbox(3)
    reach = 'many'
    let open: () => void = () => {}
    reachGate = new Promise((resolve) => {
      open = resolve
    })
    await press(markAllButton())
    const search = document.querySelector<HTMLInputElement>('[data-inbox-search]')
    await act(async () => search?.focus())
    await act(async () => open())
    await settle()
    expect(notice()).toBeNull()
    expect(sentMarks()).toEqual([])
    expect(markAllButton()?.disabled).toBe(false)
    expect(document.activeElement).toBe(search)
  })

  it('closes a row menu opened while the press waited, before the notice opens', async () => {
    const uuids = await openInbox(3)
    reach = 'many'
    let open: () => void = () => {}
    reachGate = new Promise((resolve) => {
      open = resolve
    })
    await press(markAllButton())
    await openRowMenu(uuids[1])
    await act(async () => open())
    await settle()
    expect(document.querySelector('[data-msg-menu]')).toBeNull()
    expect(notice()).not.toBeNull()
    await press(document.querySelector<HTMLElement>('[data-inbox-notice-cancel]'))
  })

  it.each(['notice', 'asking'] as const)(
    'sends nothing and shows no notice later when the kept Inbox hides while it is %s',
    async (state) => {
      await openInbox(3, null, [], { kept: true })
      reach = 'many'
      let open: () => void = () => {}
      if (state === 'asking')
        reachGate = new Promise((resolve) => {
          open = resolve
        })
      await press(markAllButton())
      await settle()
      const { P } = await import('../store/planner')
      expect(P.inboxBulk?.state).toBe(state)
      await act(async () => showKept(false))
      await settle()
      await act(async () => open())
      await settle()
      expect(P.inboxBulk).toBeNull()
      // shown again, nothing waits to ask and nothing was sent
      await act(async () => showKept(true))
      await settle()
      expect(notice()).toBeNull()
      expect(sentMarks()).toEqual([])
      expect(markAllButton()?.disabled).toBe(false)
    },
  )
})
