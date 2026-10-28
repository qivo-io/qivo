// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MENTION_DETAILS } from '../../convex/lib/messageDetails'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'
import type { Row } from '../store/rows'

/* The task window's Comments and All filters on the real store. Comments
   asks for the task's comments alone (threadComments); All asks for its
   history besides (threadHistory), and says when that is loading or
   failed. Every subscription is answered by hand. Comment #n is posted n
   minutes after START, and change(n) moves the task n minutes after it. */

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
/* One subscription the store made, its answers and whether it stopped. */
type Live = {
  name: string
  deliver: (value: unknown) => void
  fail: (e: unknown) => void
  closed: boolean
}

const START = Date.parse('2026-09-14T08:00:00.000Z')
const at = (minute: number) => new Date(START + minute * 60_000).toISOString()

let P: Planner
let container: HTMLDivElement
let root: Root
let snap: Snapshot
let me: string
let subs: Live[]

const comment = (n: number): Row<'comments'> => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  issue_id: 'task-a',
  author: me,
  body: `Check ${n}`,
  created_at: at(n),
})
const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, n) => comment(from + n))
const change = (n: number): Row<'activity_events'> => ({
  id: `event-${n}`,
  org_id: snap.orgs[0].id,
  ts: at(n),
  actor_id: me,
  verb: 'moved',
  target_type: 'issue',
  target_id: 'task-a',
  label: 'QN-27',
  detail: 'To Do → In Progress',
})

/* Loads the store with task-a, task-b and, for each of `unread`, an unread
   message about task-a of that kind at that minute, with its detail. */
async function load(
  unread: { minute: number; kind: 'comment' | 'change' | 'mention'; detail?: string }[] = [],
) {
  vi.resetModules()
  snap = plannerFixture()
  me = snap.profiles[0].id
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
    created_at: at(0),
    updated_at: at(0),
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  snap.issues.push({ ...snap.issues[0], id: 'task-b', num: 28, title: 'Write the report' })
  for (const [i, m] of unread.entries())
    snap.messages.push({
      id: `message-${i}`,
      org_id: snap.orgs[0].id,
      recipient_id: me,
      issue_id: 'task-a',
      issue_title: 'Run the soak test',
      kind: m.kind,
      detail: m.detail ?? (m.kind === 'comment' ? 'New comment' : 'To Do → In Progress'),
      created_at: at(m.minute),
    })
  subs = []
  network.onUpdate.mockImplementation((ref, _args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      next(structuredClone(snap))
      return () => {}
    }
    const live: Live = { name, deliver: next, fail, closed: false }
    subs.push(live)
    return () => {
      live.closed = true
    }
  })
  network.query.mockResolvedValue(null)
  // writes succeed, since opening the task marks its messages read
  network.mutation.mockResolvedValue(null)
  const store = await import('../store/planner')
  P = store.P
  await store.initStore()
}

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
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
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/* The open subscriptions of `name`. */
const open = (name: string) => subs.filter((s) => s.name === name && !s.closed)
/* The one open subscription of `name`. */
function one(name: string): Live {
  const live = open(name)
  expect(live).toHaveLength(1)
  return live[0]
}
const comments = (page: { comments: Row<'comments'>[]; earlier: boolean }) =>
  act(async () => one('snapshot:threadComments').deliver(page))
const history = (events: Row<'activity_events'>[], earlier = false) =>
  act(async () =>
    one('snapshot:threadHistory').deliver({
      events,
      earlier,
      next: earlier ? (events[0]?.id ?? 'hidden-row') : null,
    }),
  )

async function openTask() {
  const { IssueDetail } = await import('./IssueDetail')
  const task = P.issues.find((it) => it.uuid === 'task-a')
  if (!task) throw new Error('missing the task')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <IssueDetail issueId={task.id} onClose={vi.fn()} onOpen={vi.fn()} />
      </TooltipProvider>,
    ),
  )
}

/* The thread as rendered in `scope`, top to bottom: the control above it in
   brackets, comments by their text, a change as `event`, the New line as
   `New` and every other row by its text. */
function thread(scope: ParentNode = document): string[] {
  const feed = scope.querySelector('[data-spine]')
  if (!feed) throw new Error('missing the thread')
  return [...feed.children].map((row) => {
    const html = row as HTMLElement
    if (html.dataset.earlierComments) return `[${html.textContent}]`
    if (html.dataset.unreadDivider) return 'New'
    if (html.dataset.event) return 'event'
    if (html.dataset.comment)
      return html.querySelector('.md, p')?.textContent ?? html.textContent ?? ''
    return html.textContent ?? ''
  })
}
async function pick(name: 'All' | 'Comments', scope: ParentNode = document) {
  const button = [...scope.querySelectorAll('button')].find((b) => b.textContent === name)
  if (!button) throw new Error(`missing the ${name} filter`)
  await act(async () => button.click())
}
const tailNote = (scope: ParentNode = document) =>
  scope.querySelector('[data-unread-divider="tail"]')?.textContent

describe('the task window under Comments and All', { timeout: 20_000 }, () => {
  it('asks for no history under Comments, and for it under All until Comments again', async () => {
    await load()
    await openTask()
    await comments({ comments: range(1, 4), earlier: false })
    expect(thread()).toEqual(['Check 1', 'Check 2', 'Check 3'])
    expect(subs.map((s) => s.name)).toEqual(['snapshot:threadComments'])
    await pick('All')
    // the comments are not shown as the whole record while the history loads
    expect(thread()).toEqual(['Loading activity…'])
    await history([change(2)])
    expect(thread()).toEqual(['Check 1', 'Check 2', 'event', 'Check 3'])
    await pick('Comments')
    expect(open('snapshot:threadHistory')).toEqual([])
    expect(thread()).toEqual(['Check 1', 'Check 2', 'Check 3'])
    expect(P.threadEvents).toEqual([])
    // the comments' subscription rode on throughout
    expect(subs.filter((s) => s.name === 'snapshot:threadComments')).toHaveLength(1)
  })

  it('says "No activity yet." only once both sides are in and empty', async () => {
    await load()
    await openTask()
    await pick('All')
    expect(thread()).toEqual(['Loading activity…'])
    await history([])
    // the comments are still on their way
    expect(thread()).toEqual(['Loading activity…'])
    await comments({ comments: [], earlier: false })
    expect(thread()).toEqual(['No activity yet.'])
    await pick('Comments')
    expect(thread()).toEqual(['No comments yet.'])
  })

  it('shows a failed history with Retry, never the comments as the whole record', async () => {
    await load()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await openTask()
    await comments({ comments: range(1, 4), earlier: false })
    await pick('All')
    await act(async () => one('snapshot:threadHistory').fail(new Error('Server Error')))
    expect(thread()).toEqual(["Couldn't load activity.Retry"])
    const retry = [...document.querySelectorAll('[data-thread-side="activity"] button')]
    expect(retry.map((b) => b.textContent)).toEqual(['Retry'])
    await act(async () => (retry[0] as HTMLElement).click())
    expect(thread()).toEqual(['Loading activity…'])
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    await history([change(2)])
    expect(thread()).toEqual(['Check 1', 'Check 2', 'event', 'Check 3'])
    // a failure after the history arrived keeps it, and says the newest failed
    await act(async () => one('snapshot:threadHistory').fail(new Error('Server Error')))
    expect(thread()).toEqual([
      'Check 1',
      'Check 2',
      'event',
      'Check 3',
      "Couldn't load the latest activity.Retry",
    ])
  })

  it('says "the latest" only about rows the thread shows', async () => {
    await load()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await openTask()
    const side = (what: string) =>
      document.querySelector(`[data-thread-side="${what}"]`)?.textContent
    await comments({ comments: range(60, 110), earlier: true })
    await act(async () => one('snapshot:threadComments').fail(new Error('Server Error')))
    expect(side('comments')).toBe("Couldn't load the latest comments.Retry")
    // under All, before the history is in, no comment shows
    await pick('All')
    expect(side('comments')).toBe("Couldn't load comments.Retry")
    // a change older than every loaded comment shows only once they reach it
    await history([change(10)])
    expect(thread()).not.toContain('event')
    expect(side('comments')).toBe("Couldn't load the latest comments.Retry")
    await act(async () => one('snapshot:threadHistory').fail(new Error('Server Error')))
    expect(side('activity')).toBe("Couldn't load activity.Retry")
  })

  it('offers no earlier page under All before the history is in', async () => {
    await load()
    await openTask()
    await comments({ comments: range(60, 110), earlier: true })
    expect(thread()[0]).toBe('[Show earlier comments]')
    await pick('All')
    expect(thread()).toEqual(['Loading activity…'])
    await history([change(100)], true)
    expect(thread()[0]).toBe('[Show earlier activity]')
  })

  it('opens another task under Comments, asking for no history of it', async () => {
    await load()
    await openTask()
    await comments({ comments: range(1, 4), earlier: false })
    await pick('All')
    await history([change(2)])
    const { IssueDetail } = await import('./IssueDetail')
    const other = P.issues.find((it) => it.uuid === 'task-b')
    if (!other) throw new Error('missing the second task')
    await act(async () =>
      root.render(
        <TooltipProvider>
          <IssueDetail issueId={other.id} onClose={vi.fn()} onOpen={vi.fn()} />
        </TooltipProvider>,
      ),
    )
    expect(open('snapshot:threadHistory')).toEqual([])
    expect(subs.filter((s) => s.name === 'snapshot:threadHistory')).toHaveLength(1)
    expect(one('snapshot:threadComments')).toBeDefined()
  })

  it('points the tail note at All for a mention in the description, not in a comment', async () => {
    await load([{ minute: 20, kind: 'mention', detail: MENTION_DETAILS.description }])
    await openTask()
    await comments({ comments: range(1, 10), earlier: false })
    expect(tailNote()).toBe('New activity on this task. Changes show only under All.')
    await act(async () => root.unmount())
    root = createRoot(container)
    await load([{ minute: 20, kind: 'mention', detail: MENTION_DETAILS.comment }])
    await openTask()
    await comments({ comments: range(1, 10), earlier: false })
    expect(tailNote()).toBe('New activity on this task.')
  })

  it('points the tail note at All only for an unread change', async () => {
    await load([{ minute: 20, kind: 'change' }])
    await openTask()
    await comments({ comments: range(1, 10), earlier: false })
    expect(tailNote()).toBe('New activity on this task. Changes show only under All.')
    expect(open('snapshot:threadHistory')).toEqual([])
    // under All the change itself carries the New line
    await pick('All')
    await history([change(20)])
    expect(thread().slice(-2)).toEqual(['New', 'event'])
  })
})

describe('the Inbox pane and its pop-out', { timeout: 20_000 }, () => {
  /* Renders the Inbox as App holds it, with no task open. */
  async function openInbox() {
    const { Inbox } = await import('./Inbox')
    const { usePlannerVersion } = await import('../store/usePlannerVersion')
    function InboxHost() {
      usePlannerVersion()
      const [openIssue, setOpenIssue] = useState<string | null>(null)
      return (
        <Inbox
          showOnBoard={vi.fn()}
          onExit={vi.fn()}
          openTask={setOpenIssue}
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
  }
  /* Opens task-a's item in the pane, which marks it read. */
  async function select() {
    const row = document.querySelector<HTMLElement>('[data-message="task-a"] .inbox-message-open')
    if (!row) throw new Error('missing the row')
    await act(async () => row.click())
  }
  const pane = () => {
    const frame = document.querySelector('.inbox-detail-frame')
    if (!frame) throw new Error('missing the pane')
    return frame
  }
  const popOut = () => document.querySelector('[role="dialog"]:not(.inbox-detail-frame *)')

  it("leaves the pane's scroll alone while its pop-out loads and drops the history", async () => {
    await load([{ minute: 3, kind: 'comment' }])
    await openInbox()
    await select()
    await comments({ comments: range(1, 4), earlier: false })
    // jsdom lays nothing out: the pane's scroller is 5,000 px tall, and the
    // reader scrolled it up, which is what a snap to its end would undo
    const scroller = pane().querySelector<HTMLElement>('[data-spine-scroll]')
    if (!scroller) throw new Error('missing the scroller')
    const snaps: number[] = []
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, get: () => 5000 },
      scrollTop: {
        configurable: true,
        get: () => 1000,
        set: (value: number) => snaps.push(value),
      },
    })
    const button = pane().querySelector<HTMLElement>('[data-task-popout]')
    if (!button) throw new Error('missing the pop-out button')
    await act(async () => button.click())
    const dialog = popOut()
    if (!dialog) throw new Error('the pop-out did not open')
    await pick('All', dialog)
    await history([change(2)])
    await pick('Comments', dialog)
    await pick('All', dialog)
    await history([change(2)])
    expect(snaps).toEqual([])
  })

  it('freezes whether a change was unread before its click marks the item read', async () => {
    await load([{ minute: 20, kind: 'change' }])
    await openInbox()
    await select()
    expect(P.messages.every((m) => m.read)).toBe(true)
    await comments({ comments: range(1, 10), earlier: false })
    expect(tailNote(pane())).toBe('New activity on this task. Changes show only under All.')
  })

  it('does not point at All when only a deleted comment was unread', async () => {
    await load([{ minute: 20, kind: 'comment' }])
    await openInbox()
    await select()
    await comments({ comments: range(1, 10), earlier: false })
    expect(tailNote(pane())).toBe('New activity on this task.')
  })

  it('subscribes the history once for the pop-out on All, and stops it as the pop-out leaves All', async () => {
    await load([{ minute: 3, kind: 'comment' }])
    // the rows without the New line the unread comment draws in the pane
    const shown = (scope: ParentNode) => thread(scope).filter((row) => row !== 'New')
    await openInbox()
    await select()
    await comments({ comments: range(1, 4), earlier: false })
    const button = pane().querySelector<HTMLElement>('[data-task-popout]')
    if (!button) throw new Error('missing the pop-out button')
    await act(async () => button.click())
    const dialog = popOut()
    if (!dialog) throw new Error('the pop-out did not open')
    expect(open('snapshot:threadHistory')).toEqual([])
    await pick('All', dialog)
    expect(open('snapshot:threadHistory')).toHaveLength(1)
    await history([change(2)])
    expect(shown(dialog)).toEqual(['Check 1', 'Check 2', 'event', 'Check 3'])
    // the pane, under Comments, shows the comments alone
    expect(shown(pane())).toEqual(['Check 1', 'Check 2', 'Check 3'])
    // the pane on All too shares the one subscription
    await pick('All', pane())
    expect(subs.filter((s) => s.name === 'snapshot:threadHistory')).toHaveLength(1)
    await pick('Comments', pane())
    expect(open('snapshot:threadHistory')).toHaveLength(1)
    await pick('Comments', dialog)
    expect(open('snapshot:threadHistory')).toEqual([])
    expect(shown(pane())).toEqual(['Check 1', 'Check 2', 'Check 3'])
    expect(open('snapshot:threadComments')).toHaveLength(1)
  })
})
