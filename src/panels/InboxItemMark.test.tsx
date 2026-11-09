// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MENTION_DETAILS } from '../../convex/lib/messageDetails'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot, underProgram } from '../store/plannerFixture.setup'
import type { Row } from '../store/rows'

/* The task window's New divider, its tail note and its read on open from
   the task's inbox item (convex/inbox.ts item, store/planner.ts
   P.inboxItem), on the real store over the live double, which answers the
   item from the server's messages through its stand-in
   (store/inboxStandIn.setup.ts). The store holds no message, so the
   divider and the read come from the item alone. The read waits for the item's answer, takes the task's
   organization, uuid and the answer's `through`, goes once a `through`,
   and never for a snoozed item, a seat whose items are building, a failed
   read or no item. An Inbox row's press only opens its task, whose pane
   freezes the start from the item as any window does, and the pane and its
   pop-out send one read for one `through`. A read the server refused is
   not sent again for its `through`. Once the person marks the open task
   unread, nothing reads it again while it stays open, from the moment the
   write goes out. A refused or failed unread write takes away only its own
   part of that hold, and a write of an earlier visit holds nothing. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
type Double = ReturnType<typeof import('../store/guard/liveDouble.setup').liveOver>
const double = vi.hoisted(() => ({ live: null as Double | null }))
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

type Planner = typeof import('../store/planner')['P']

const START = Date.parse('2026-09-14T08:00:00.000Z')
const at = (minute: number) => new Date(START + minute * 60_000).toISOString()

let P: Planner
let container: HTMLDivElement
let root: Root
let snap: Snapshot
// more messages the server holds, which a test changes apart from the rest
let beyond: Row<'messages'>[]
let me: string
let publish: () => void
// the thread subscriptions the store made, and whether each stopped
let threads: { next: (value: unknown) => void; closed: boolean }[]
// the writes the store sent, which wait until a test answers, refuses or
// fails them
let writes: {
  name: string
  args: Record<string, unknown>
  answer: () => void
  refuse: () => void
  fail: () => void
}[]

const comment = (n: number): Row<'comments'> => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  issue_id: 'task-a',
  author: me,
  body: `Check ${n}`,
  created_at: at(n),
})
const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, n) => comment(from + n))

/** A message of the server about `task` at `minute`, to the fixture's
    person in its organization, which load() names for one made before it. */
function message(
  task: string,
  minute: number,
  over: Partial<Row<'messages'>> = {},
): Row<'messages'> {
  return {
    id: `message-${task}-${minute}`,
    org_id: '',
    recipient_id: '',
    issue_id: task,
    issue_title: 'Run the soak test',
    kind: 'mention',
    detail: MENTION_DETAILS.comment,
    created_at: at(minute),
    ...over,
  }
}

/* `m` in the fixture's organization, to its person, unless it names
   another. */
const mine = (m: Row<'messages'>): Row<'messages'> => ({
  ...m,
  org_id: m.org_id || snap.orgs[0].id,
  recipient_id: m.recipient_id || me,
})

/* Loads the store with task-a and task-b, and what `edit` adds, the server
   holding the messages `held` and `loaded`, each in the fixture's
   organization unless it names another; a test changes `held` through
   `beyond` and `loaded` through the whole's own messages. The store holds
   none of them. */
async function load(
  held: Row<'messages'>[] = [],
  loaded: Row<'messages'>[] = [],
  edit?: (snap: Snapshot) => void,
) {
  vi.resetModules()
  // vi.resetModules keeps the live double, and with it a state forced before
  double.live?.forceInbox(null)
  snap = underProgram(plannerFixture())
  me = snap.profiles[0].id
  for (const [n, id] of ['task-a', 'task-b'].entries())
    snap.issues.push({
      id,
      org_id: snap.orgs[0].id,
      project_id: snap.projects[0].id,
      num: 27 + n,
      title: n ? 'Write the report' : 'Run the soak test',
      description: '',
      status: 'progress',
      priority: 'medium',
      paused: false,
      created_at: at(0),
      updated_at: at(0),
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
  edit?.(snap)
  beyond = held
  snap.messages = loaded.map(mine)
  threads = []
  writes = []
  network.onUpdate.mockImplementation((ref, _args, next) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      publish = () =>
        next(structuredClone({ ...snap, messages: [...snap.messages, ...beyond.map(mine)] }))
      publish()
    } else if (name === 'snapshot:threadComments') {
      const thread = { next, closed: false }
      threads.push(thread)
      return () => {
        thread.closed = true
      }
    }
    return () => {}
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'identity:claimMySeats') return Promise.resolve(null)
    return new Promise((resolve, reject) =>
      writes.push({
        name,
        args,
        answer: () => resolve(null),
        refuse: () => reject(new ConvexError({ code: 'forbidden', message: 'no' })),
        fail: () => reject(new Error('Server Error')),
      }),
    )
  })
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
  vi.spyOn(console, 'error').mockImplementation(() => {})
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  double.live?.forceInbox(null)
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const settle = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))

async function openTask(uuid = 'task-a') {
  const { IssueDetail } = await import('./IssueDetail')
  const row = snap.issues.find((it) => it.id === uuid)
  if (!row) throw new Error(`missing ${uuid}`)
  // the store holds no task, so the window opens by a reference and shows
  // the task from its own answer
  const task = { id: P.openTask(row.id, row.org_id, row.num) }
  await act(async () =>
    root.render(
      <TooltipProvider>
        <IssueDetail issueId={task.id} onClose={vi.fn()} onOpen={vi.fn()} />
      </TooltipProvider>,
    ),
  )
  await settle()
}

/* Delivers the comments of the one open thread subscription, and lets the
   store paint them, which it does on a timer while a painted write waits. */
async function comments(rows: Row<'comments'>[]) {
  const open = threads.filter((thread) => !thread.closed)
  expect(open).toHaveLength(1)
  await act(async () => open[0].next({ comments: rows, earlier: false }))
  await settle()
}

/* The thread as rendered in `scope`, top to bottom: comments by their
   text, the New line as `New`. */
function thread(scope: ParentNode = document): string[] {
  const feed = scope.querySelector('[data-spine]')
  if (!feed) throw new Error('missing the thread')
  return [...feed.children].map((row) => {
    const html = row as HTMLElement
    if (html.dataset.unreadDivider) return 'New'
    if (html.dataset.comment)
      return html.querySelector('.md, p')?.textContent ?? html.textContent ?? ''
    return html.textContent ?? ''
  })
}
const tailNote = (scope: ParentNode = document) =>
  scope.querySelector('[data-unread-divider="tail"]')?.textContent ?? null
/* The item reads the store sent, by their arguments. */
const itemReads = () => writes.filter((w) => w.name === 'messages:readItem').map((w) => w.args)

describe("the task window's New mark from the inbox item", { timeout: 20_000 }, () => {
  it("draws the divider at the item's first unread message, which the workspace never loaded", async () => {
    await load([message('task-a', 5), message('task-a', 7)])
    await openTask()
    await comments(range(1, 10))
    // at or after the start, as a comment and its notice share one time
    expect(thread()).toEqual([
      'Check 1',
      'Check 2',
      'Check 3',
      'Check 4',
      'New',
      'Check 5',
      'Check 6',
      'Check 7',
      'Check 8',
      'Check 9',
    ])
    expect(tailNote()).toBeNull()
  })

  it('points the tail note at All for an unread change, a mention in the description alone included', async () => {
    await load([message('task-a', 20, { detail: MENTION_DETAILS.description })])
    await openTask()
    await comments(range(1, 4))
    expect(tailNote()).toBe('New activity on this task. Changes show only under All.')
    await act(async () => root.unmount())
    root = createRoot(container)
    await load([message('task-a', 20)])
    await openTask()
    await comments(range(1, 4))
    expect(tailNote()).toBe('New activity on this task.')
  })

  it('draws no mark and sends no read while the item loads, is building, failed or holds nothing', async () => {
    for (const force of ['loading', 'notReady', 'failed', null] as const) {
      await load(force === null ? [] : [message('task-a', 5)])
      if (force) double.live?.forceInbox(force, 'inbox:item')
      await openTask()
      await comments(range(1, 10))
      expect(thread(), String(force)).not.toContain('New')
      expect(tailNote(), String(force)).toBeNull()
      expect(itemReads(), String(force)).toEqual([])
      expect(P.inboxItem?.state).toBe(
        force === 'loading' ? 'loading' : force === 'notReady' ? 'building' : (force ?? 'ok'),
      )
      await act(async () => root.unmount())
      root = createRoot(container)
    }
  })
})

describe("the task window's read on open", { timeout: 20_000 }, () => {
  it("waits for the item's answer, then reads the item with its organization, task and through", async () => {
    await load([message('task-a', 5), message('task-a', 7)])
    double.live?.forceInbox('loading', 'inbox:item')
    await openTask()
    expect(P.inboxItem?.state).toBe('loading')
    expect(itemReads()).toEqual([])
    // the answer freezes the start, and only then does the read go out
    await act(async () => double.live?.forceInbox(null))
    await settle()
    expect(itemReads()).toEqual([
      { org_id: snap.orgs[0].id, issue_id: 'task-a', through: Date.parse(at(7)) },
    ])
    // never the loaded messages' read
    expect(writes.map((w) => w.name)).toEqual(['messages:readItem'])
    // and the divider it froze stays while the read lands
    await comments(range(1, 10))
    expect(thread()).toContain('New')
  })

  it('reads each through once, and again for a later one', async () => {
    await load([message('task-a', 5)])
    await openTask()
    expect(itemReads()).toHaveLength(1)
    // answers that hold the same through send nothing more, also once the
    // read was confirmed and nothing came after it
    await act(async () => writes[0].answer())
    await act(async () => publish())
    await settle()
    expect(itemReads()).toHaveLength(1)
    // a message that arrived while the task is open
    beyond = [...beyond, message('task-a', 12)]
    await act(async () => publish())
    await settle()
    expect(itemReads()).toEqual([
      { org_id: snap.orgs[0].id, issue_id: 'task-a', through: Date.parse(at(5)) },
      { org_id: snap.orgs[0].id, issue_id: 'task-a', through: Date.parse(at(12)) },
    ])
  })

  it('reads once more when an answer after the confirmation still holds unread at the same through', async () => {
    await load([message('task-a', 5)])
    await openTask()
    expect(itemReads()).toHaveLength(1)
    // the server read the item, and a message whose write started before
    // the read committed after it, with an earlier time
    await act(async () => writes[0].answer())
    beyond = [{ ...message('task-a', 5), read_at: at(6) }, message('task-a', 4, { id: 'late' })]
    await act(async () => publish())
    await settle()
    expect(P.inboxItem?.item).toMatchObject({ unread_count: 1, through: Date.parse(at(5)) })
    expect(itemReads()).toHaveLength(2)
    expect(itemReads()[1]).toEqual(itemReads()[0])
    // only once more, so a later answer at the same through, still
    // unread, sends nothing
    await act(async () => writes[1].answer())
    beyond = beyond.map((m) => (m.id === 'late' ? { ...m, dropped: 1 } : m))
    await act(async () => publish())
    await settle()
    expect(P.inboxItem?.item).toMatchObject({ unread_count: 1, dropped: 1 })
    expect(itemReads()).toHaveLength(2)
  })

  it('reads once more when the answer that came with the confirmation still holds unread at the same through', async () => {
    await load([message('task-a', 5)])
    await openTask()
    expect(itemReads()).toHaveLength(1)
    // the server read the item, and a message whose write started before
    // the read committed after it, with an earlier time; the transition
    // that brings that answer runs before the read's promise resolves, as
    // Convex orders them (lib/convexOrdering.test.ts), and nothing comes
    // after it
    beyond = [{ ...message('task-a', 5), read_at: at(6) }, message('task-a', 4, { id: 'late' })]
    await act(async () => publish())
    await settle()
    expect(P.inboxItem?.item).toMatchObject({ unread_count: 1, through: Date.parse(at(5)) })
    // not yet, as the server has not confirmed the read
    expect(itemReads()).toHaveLength(1)
    await act(async () => writes[0].answer())
    await settle()
    expect(itemReads()).toHaveLength(2)
    expect(itemReads()[1]).toEqual(itemReads()[0])
    // and only once more
    await act(async () => writes[1].answer())
    await settle()
    expect(itemReads()).toHaveLength(2)
  })

  it('never sends a read the server refused again for its through', async () => {
    await load([message('task-a', 5)])
    await openTask()
    expect(itemReads()).toHaveLength(1)
    await act(async () => writes[0].refuse())
    await settle()
    // a later answer at the same through, still unread
    beyond = beyond.map((m) => ({ ...m, dropped: 1 }))
    await act(async () => publish())
    await settle()
    expect(P.inboxItem?.item).toMatchObject({ unread_count: 1, dropped: 1 })
    expect(itemReads()).toHaveLength(1)
  })

  it('sends nothing for a snoozed item', async () => {
    const until = new Date(Date.now() + 86_400_000).toISOString()
    await load([message('task-a', 5, { snoozed_until: until })])
    await openTask()
    expect(P.inboxItem?.item).toMatchObject({ unread_count: 1, snoozed_until: until })
    expect(itemReads()).toEqual([])
  })

  it('leaves the open task unread once its snooze ends from this client', async () => {
    const until = new Date(Date.now() + 86_400_000).toISOString()
    await load([], [message('task-a', 5, { kind: 'comment', snoozed_until: until })])
    await openTask()
    expect(itemReads()).toEqual([])
    // Unsnooze, which brings the item back unread
    await act(async () =>
      P.snoozeItem({ org: snap.orgs[0].id, task: 'task-a', through: Date.parse(at(5)) }, null),
    )
    const wake = writes.find((w) => w.name === 'messages:snoozeItem')
    if (!wake) throw new Error('no snooze write went out')
    snap.messages = snap.messages.map(({ snoozed_until: _, ...m }) => m)
    await act(async () => publish())
    await act(async () => wake.answer())
    await settle()
    expect(P.inboxItem?.item).toMatchObject({ unread_count: 1, snoozed_until: null })
    expect(itemReads()).toEqual([])
  })

  it('reads the open task when its snooze ends after the server refused its Unsnooze', async () => {
    const until = new Date(Date.now() + 86_400_000).toISOString()
    await load([], [message('task-a', 5, { kind: 'comment', snoozed_until: until })])
    await openTask()
    await act(async () =>
      P.snoozeItem({ org: snap.orgs[0].id, task: 'task-a', through: Date.parse(at(5)) }, null),
    )
    const wake = writes.find((w) => w.name === 'messages:snoozeItem')
    if (!wake) throw new Error('no snooze write went out')
    await act(async () => wake.refuse())
    await settle()
    expect(P.inboxItem?.item).toMatchObject({ unread_count: 1, snoozed_until: until })
    expect(itemReads()).toEqual([])
    // another device ends the snooze, at the same through
    snap.messages = snap.messages.map(({ snoozed_until: _, ...m }) => m)
    await act(async () => publish())
    await settle()
    expect(P.inboxItem?.item).toMatchObject({ unread_count: 1, snoozed_until: null })
    expect(itemReads()).toEqual([
      { org_id: snap.orgs[0].id, issue_id: 'task-a', through: Date.parse(at(5)) },
    ])
  })

  it('reads an update that came while an unread write waited, once the server refuses it', async () => {
    await load([], [message('task-a', 5, { kind: 'comment', read_at: at(6) })])
    await openTask()
    await act(async () =>
      P.unreadItem({ org: snap.orgs[0].id, task: 'task-a', through: Date.parse(at(5)) }),
    )
    const unread = writes.find((w) => w.name === 'messages:unreadItem')
    if (!unread) throw new Error('no unread write went out')
    // the update stays unread while the write waits
    snap.messages = [...snap.messages, mine(message('task-a', 12, { kind: 'comment' }))]
    await act(async () => publish())
    await settle()
    expect(P.inboxItem?.item).toMatchObject({ unread_count: 1, through: Date.parse(at(12)) })
    expect(itemReads()).toEqual([])
    // and is read once the refusal takes the hold away
    await act(async () => unread.refuse())
    await settle()
    expect(itemReads()).toEqual([
      { org_id: snap.orgs[0].id, issue_id: 'task-a', through: Date.parse(at(12)) },
    ])
  })

  it('keeps the hold of an accepted unread write when an earlier one of the task fails', async () => {
    await load(
      [],
      [
        message('task-a', 5, { kind: 'comment', read_at: at(6) }),
        message('task-a', 7, { kind: 'comment', read_at: at(8) }),
      ],
    )
    await openTask()
    await act(async () =>
      P.unreadItem({ org: snap.orgs[0].id, task: 'task-a', through: Date.parse(at(5)) }),
    )
    await act(async () =>
      P.unreadItem({ org: snap.orgs[0].id, task: 'task-a', through: Date.parse(at(7)) }),
    )
    const [earlier, later] = writes.filter((w) => w.name === 'messages:unreadItem')
    if (!later) throw new Error('two unread writes did not go out')
    // the server accepts the later write, then the earlier one fails
    snap.messages = snap.messages.map((m) => {
      if (m.id !== 'message-task-a-7') return m
      const { read_at: _, ...unread } = m
      return unread
    })
    await act(async () => publish())
    await act(async () => later.answer())
    await act(async () => earlier.fail())
    await settle()
    expect(P.inboxItem?.item).toMatchObject({ unread_count: 1, through: Date.parse(at(7)) })
    // nothing reads the task, also for a later update
    snap.messages = [...snap.messages, mine(message('task-a', 12, { kind: 'comment' }))]
    await act(async () => publish())
    await settle()
    expect(P.inboxItem?.item).toMatchObject({ unread_count: 2, through: Date.parse(at(12)) })
    expect(itemReads()).toEqual([])
  })

  it('holds nothing in the next visit for an unread write of an earlier one', async () => {
    await load([], [message('task-a', 5, { kind: 'comment', read_at: at(6) })])
    await openTask()
    await act(async () =>
      P.unreadItem({ org: snap.orgs[0].id, task: 'task-a', through: Date.parse(at(5)) }),
    )
    const unread = writes.find((w) => w.name === 'messages:unreadItem')
    if (!unread) throw new Error('no unread write went out')
    // the window closes and opens the task again while the write waits
    await act(async () => root.unmount())
    root = createRoot(container)
    await openTask()
    // the server accepts it, and the new visit reads the task on open
    snap.messages = snap.messages.map(({ read_at: _, ...m }) => m)
    await act(async () => publish())
    await act(async () => unread.answer())
    await settle()
    expect(itemReads()).toEqual([
      { org_id: snap.orgs[0].id, issue_id: 'task-a', through: Date.parse(at(5)) },
    ])
    // and a later update too
    snap.messages = [...snap.messages, mine(message('task-a', 12, { kind: 'comment' }))]
    await act(async () => publish())
    await settle()
    expect(itemReads()).toHaveLength(2)
    expect(itemReads()[1]).toMatchObject({ through: Date.parse(at(12)) })
  })

  it("reads only the task it shows, in that task's organization", async () => {
    await load([message('task-a', 5), message('task-b', 6)])
    await openTask('task-b')
    expect(itemReads()).toEqual([
      { org_id: snap.orgs[0].id, issue_id: 'task-b', through: Date.parse(at(6)) },
    ])
    expect(P.readOnOpen('task-a')).toBe(false)
    expect(itemReads()).toHaveLength(1)
  })

  it('reads a task of another organization there, not in the home organization', async () => {
    const org = '00000000-0000-4000-8000-0000000000b2'
    const seat = 'profile-second'
    await load([message('task-x', 5, { org_id: org, recipient_id: seat })], [], (snap) => {
      // a guest seat of the login in a second organization, with one task
      snap.orgs.push({ ...snap.orgs[0], id: org, name: 'Second', slug: 'second' })
      snap.profiles.push({ ...snap.profiles[0], id: seat, org_id: org, org_role: 'guest' })
      snap.myProfileIds.push(seat)
      // its sub-project under a top-level project of its own
      snap.projects.push(
        {
          ...snap.projects[0],
          id: 'program-x',
          org_id: org,
          key: 'SEP',
          type: 'meta',
          parent_id: undefined,
          lead_id: undefined,
        },
        {
          ...snap.projects[0],
          id: 'project-x',
          org_id: org,
          key: 'SEC',
          parent_id: 'program-x',
          lead_id: undefined,
        },
      )
      snap.access.push({ project_id: 'project-x', profile_id: seat, level: 'user' })
      snap.issues.push({
        ...snap.issues[0],
        id: 'task-x',
        org_id: org,
        project_id: 'project-x',
        num: 1,
        title: 'Calibrate the second rig',
      })
    })
    expect(P.homeOrg).not.toBe(org)
    await openTask('task-x')
    expect(itemReads()).toEqual([{ org_id: org, issue_id: 'task-x', through: Date.parse(at(5)) }])
  })
})

describe('a building or failed item', { timeout: 20_000 }, () => {
  it('keeps the start pending through it, then draws the divider and reads once', async () => {
    for (const force of ['notReady', 'failed'] as const) {
      await load([message('task-a', 5), message('task-a', 7)])
      double.live?.forceInbox(force, 'inbox:item')
      await openTask()
      await comments(range(1, 10))
      expect(P.inboxItem?.state, force).toBe(force === 'notReady' ? 'building' : 'failed')
      expect(thread(), force).not.toContain('New')
      expect(itemReads(), force).toEqual([])
      // the seat's items are ready, or the read answers again
      await act(async () => double.live?.forceInbox(null))
      await settle()
      expect(thread().slice(3, 6), force).toEqual(['Check 4', 'New', 'Check 5'])
      expect(itemReads(), force).toEqual([
        { org_id: snap.orgs[0].id, issue_id: 'task-a', through: Date.parse(at(7)) },
      ])
      await act(async () => root.unmount())
      root = createRoot(container)
    }
  })

  it('runs a failed item once more by itself, and not twice', async () => {
    await load([message('task-a', 5)])
    const live = double.live
    if (!live) throw new Error('the live double is not set up')
    // the item reads the store's registry watches
    const own = live.watch
    let itemWatches = 0
    live.watch = (ref, args, sharing) => {
      if (getFunctionName(ref) === 'inbox:item') itemWatches++
      return own(ref, args, sharing)
    }
    try {
      live.forceInbox('failed', 'inbox:item')
      await openTask()
      await settle()
      await settle()
      // the window's own watch and one rerun, whose failure stays
      expect(itemWatches).toBe(2)
      expect(P.inboxItem?.state).toBe('failed')
      expect(console.error).toHaveBeenCalledWith(
        '[qivo] inbox item subscription failed:',
        expect.anything(),
      )
      // nothing is read, and the badge still counts the task
      expect(itemReads()).toEqual([])
      expect(P.inboxSummary.answer?.unread_count).toBe(1)
    } finally {
      live.watch = own
    }
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
  const pane = () => {
    const frame = document.querySelector('.inbox-detail-frame')
    if (!frame) throw new Error('missing the pane')
    return frame
  }
  const popOut = () => document.querySelector('[role="dialog"]:not(.inbox-detail-frame *)')

  /* Opens task-a, with one loaded update, from its Inbox row, lets the
     server read the item and confirm the pane's read, then sends Mark as
     unread from the open task's own row menu. Answers the row and the
     unread write, which waits. */
  async function markOpenRowUnread() {
    // the row menu places itself with a ResizeObserver, which jsdom lacks
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    await load([], [message('task-a', 5, { kind: 'comment' })])
    await openInbox()
    const rowOf = () => document.querySelector<HTMLElement>('[data-message="task-a"]')
    const open = rowOf()?.querySelector<HTMLElement>('.inbox-message-open')
    if (!open) throw new Error('missing the row')
    await act(async () => open.click())
    await settle()
    expect(itemReads()).toHaveLength(1)
    // the server read the item, and confirmed the read
    snap.messages = snap.messages.map((m) => ({ ...m, read_at: at(6) }))
    await act(async () => publish())
    await act(async () => writes[0].answer())
    await settle()
    expect(P.inboxItem?.item).toMatchObject({ unread_count: 0 })
    // Mark as unread from the open task's own row menu
    await act(async () => {
      open.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    const markUnread = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-msg-menu] button'),
    ].find((b) => b.textContent?.includes('Mark as unread'))
    if (!markUnread) throw new Error('missing Mark as unread')
    await act(async () => markUnread.click())
    await settle()
    // the item's unread write, by its organization and task
    const unread = writes.find((w) => w.name === 'messages:unreadItem')
    if (!unread) throw new Error('the row menu sent no unread')
    expect(unread.args).toEqual({ org_id: snap.orgs[0].id, issue_id: 'task-a' })
    return { rowOf, unread }
  }

  it('leaves the open task unread after Mark as unread from its row, also for later answers', async () => {
    const { rowOf, unread } = await markOpenRowUnread()
    // the server marked it unread, at the same through
    snap.messages = snap.messages.map(({ read_at: _, ...m }) => m)
    await act(async () => publish())
    await act(async () => unread.answer())
    await settle()
    expect(P.inboxItem?.item).toMatchObject({ unread_count: 1, through: Date.parse(at(5)) })
    expect(itemReads()).toHaveLength(1)
    // a later update, with a newer through, stays unread too
    snap.messages = [...snap.messages, mine(message('task-a', 12, { kind: 'comment' }))]
    await act(async () => publish())
    await settle()
    expect(P.inboxItem?.item).toMatchObject({ unread_count: 2, through: Date.parse(at(12)) })
    expect(itemReads()).toHaveLength(1)
    expect(rowOf()?.hasAttribute('data-unread')).toBe(true)
  })

  it('reads the open task again once the server refuses Mark as unread from its row', async () => {
    const { rowOf, unread } = await markOpenRowUnread()
    await act(async () => unread.refuse())
    await settle()
    // the refusal undid the row's unread, and the item stays read
    expect(rowOf()?.hasAttribute('data-unread')).toBe(false)
    expect(P.inboxItem?.item).toMatchObject({ unread_count: 0 })
    expect(itemReads()).toHaveLength(1)
    // a later answer with unread at the same through, as after another
    // device's Mark as unread, gets the one more read the rule allows
    snap.messages = snap.messages.map(({ read_at: _, ...m }) => m)
    await act(async () => publish())
    await settle()
    expect(P.inboxItem?.item).toMatchObject({ unread_count: 1, through: Date.parse(at(5)) })
    expect(itemReads()).toHaveLength(2)
    expect(itemReads()[1]).toEqual(itemReads()[0])
  })

  it("reads later news on open again once the row's Mark as read of the open task is accepted", async () => {
    const { rowOf, unread } = await markOpenRowUnread()
    snap.messages = snap.messages.map(({ read_at: _, ...m }) => m)
    await act(async () => publish())
    await act(async () => unread.answer())
    await settle()
    // Mark as read from the open task's own row, the person's newer choice
    const open = rowOf()?.querySelector<HTMLElement>('.inbox-message-open')
    if (!open) throw new Error('missing the row')
    await act(async () => {
      open.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    const markRead = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-msg-menu] button'),
    ].find((b) => b.textContent?.includes('Mark as read'))
    if (!markRead) throw new Error('missing Mark as read')
    await act(async () => markRead.click())
    await settle()
    expect(itemReads()).toHaveLength(2)
    expect(itemReads()[1]).toEqual({
      org_id: snap.orgs[0].id,
      issue_id: 'task-a',
      through: Date.parse(at(5)),
    })
    // the row turned read at once
    expect(rowOf()?.hasAttribute('data-unread')).toBe(false)
    snap.messages = snap.messages.map((m) => ({ ...m, read_at: at(13) }))
    await act(async () => publish())
    const read = writes.filter((w) => w.name === 'messages:readItem')[1]
    await act(async () => read.answer())
    await settle()
    // later news on the open task is read on open again
    snap.messages = [...snap.messages, mine(message('task-a', 14, { kind: 'comment' }))]
    await act(async () => publish())
    await settle()
    expect(itemReads()).toHaveLength(3)
    expect(itemReads()[2]).toEqual({
      org_id: snap.orgs[0].id,
      issue_id: 'task-a',
      through: Date.parse(at(14)),
    })
  })

  it("draws the pane's divider at the item's first unread, and sends one read for one through from both", async () => {
    // the row's loaded message at minute 8, and an older unread one beyond
    // the cut, which the list does not load
    await load([message('task-a', 3)], [message('task-a', 8, { kind: 'comment' })])
    await openInbox()
    const rowOf = () => document.querySelector<HTMLElement>('[data-message="task-a"]')
    const row = rowOf()?.querySelector<HTMLElement>('.inbox-message-open')
    if (!row) throw new Error('missing the row')
    expect(rowOf()?.hasAttribute('data-unread')).toBe(true)
    await act(async () => row.click())
    await settle()
    // the press only opened the task, and the pane read the whole item,
    // whose paint turned the row read
    expect(writes.map((w) => w.name)).toEqual(['messages:readItem'])
    expect(itemReads()).toEqual([
      { org_id: snap.orgs[0].id, issue_id: 'task-a', through: Date.parse(at(8)) },
    ])
    expect(rowOf()?.hasAttribute('data-unread')).toBe(false)
    await comments(range(1, 10))
    // the divider sits at the item's first unread update, the one the
    // list did not load
    expect(thread(pane()).slice(0, 4)).toEqual(['Check 1', 'Check 2', 'New', 'Check 3'])
    const button = pane().querySelector<HTMLElement>('[data-task-popout]')
    if (!button) throw new Error('missing the pop-out button')
    await act(async () => button.click())
    await settle()
    const dialog = popOut()
    if (!dialog) throw new Error('the pop-out did not open')
    // the pop-out shows no mark of its own, and sends no second read
    expect(thread(dialog)).not.toContain('New')
    expect(itemReads()).toHaveLength(1)
  })

  it('shows news that arrived while the page was hidden under New in the pop-out too, and reads it once', async () => {
    await load([], [message('task-a', 5, { kind: 'comment' })])
    await openInbox()
    const row = document.querySelector<HTMLElement>('[data-message="task-a"] .inbox-message-open')
    if (!row) throw new Error('missing the row')
    await act(async () => row.click())
    await settle()
    expect(itemReads()).toHaveLength(1)
    // the server read the item, and confirmed the read
    snap.messages = snap.messages.map((m) => ({ ...m, read_at: at(6) }))
    await act(async () => publish())
    await act(async () => writes[0].answer())
    await settle()
    await comments(range(1, 7))
    const button = pane().querySelector<HTMLElement>('[data-task-popout]')
    if (!button) throw new Error('missing the pop-out button')
    await act(async () => button.click())
    await settle()
    expect(thread(popOut() ?? document)).not.toContain('New')
    // the page hides, and a comment's message arrives meanwhile
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await settle()
    beyond = [message('task-a', 8)]
    await act(async () => publish())
    await settle()
    expect(itemReads()).toHaveLength(1)
    await act(async () => {
      Reflect.deleteProperty(document, 'visibilityState')
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await settle()
    await comments(range(1, 9))
    await settle()
    const dialog = popOut()
    if (!dialog) throw new Error('the pop-out closed')
    // the pop-out the person looks at shows it under New, as the pane does
    expect(thread(dialog).slice(-3)).toEqual(['Check 7', 'New', 'Check 8'])
    expect(thread(pane()).slice(-3)).toEqual(['Check 7', 'New', 'Check 8'])
    expect(itemReads()).toEqual([
      { org_id: snap.orgs[0].id, issue_id: 'task-a', through: Date.parse(at(5)) },
      { org_id: snap.orgs[0].id, issue_id: 'task-a', through: Date.parse(at(8)) },
    ])
  })
})

describe('a return to a hidden page', { timeout: 20_000 }, () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState')
  })
  /** Sets the page's visibility, as the browser does when a tab hides. */
  const setVisibility = (value: 'visible' | 'hidden') =>
    act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
      document.dispatchEvent(new Event('visibilitychange'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  const reads = () => document.querySelector('[aria-label="Task"]')
  const state = () => reads()?.getAttribute('data-task-window-reads')

  it('marks the window refreshing from the hide until its reads answer again, for assistive technology only', async () => {
    await load([message('task-a', 5)])
    await openTask()
    await comments(range(1, 6))
    expect(state()).toBe('current')
    expect(reads()?.getAttribute('aria-busy')).toBeNull()
    await setVisibility('hidden')
    expect(state()).toBe('refreshing')
    expect(reads()?.getAttribute('aria-busy')).toBe('true')
    // the held thread stays on screen
    expect(thread()).toContain('Check 5')
    await setVisibility('visible')
    // the item and the task answered again; the thread has not yet
    expect(state()).toBe('refreshing')
    await comments(range(1, 6))
    expect(state()).toBe('current')
    expect(reads()?.getAttribute('aria-busy')).toBeNull()
  })

  it('leaves news that arrived while hidden unread, then shows it under New and reads it once', async () => {
    await load()
    await openTask()
    await comments(range(1, 5))
    expect(thread()).not.toContain('New')
    await setVisibility('hidden')
    beyond = [message('task-a', 6)]
    await act(async () => publish())
    await settle()
    // the badge counts it, and nothing reads it
    expect(P.inboxSummary.answer?.unread_count).toBe(1)
    expect(itemReads()).toEqual([])
    await setVisibility('visible')
    await comments(range(1, 7))
    expect(thread()).toEqual([
      'Check 1',
      'Check 2',
      'Check 3',
      'Check 4',
      'Check 5',
      'New',
      'Check 6',
    ])
    expect(itemReads()).toEqual([
      { org_id: snap.orgs[0].id, issue_id: 'task-a', through: Date.parse(at(6)) },
    ])
  })

  it("keeps the visit's mark on a return with no news", async () => {
    await load([message('task-a', 5)])
    await openTask()
    await comments(range(1, 8))
    expect(thread().indexOf('New')).toBe(4)
    expect(itemReads()).toHaveLength(1)
    // the server read it, and confirmed the read
    beyond = beyond.map((m) => ({ ...m, read_at: at(6) }))
    await act(async () => publish())
    await act(async () => writes[0].answer())
    await settle()
    await setVisibility('hidden')
    await setVisibility('visible')
    await comments(range(1, 8))
    expect(thread().indexOf('New')).toBe(4)
    expect(itemReads()).toHaveLength(1)
  })

  it("draws no new mark for the person's own Mark as unread on a return", async () => {
    await load([], [message('task-a', 5, { kind: 'comment', read_at: at(6) })])
    await openTask()
    await comments(range(1, 8))
    expect(thread()).not.toContain('New')
    await act(async () =>
      P.unreadItem({ org: snap.orgs[0].id, task: 'task-a', through: Date.parse(at(5)) }),
    )
    const unread = writes.find((w) => w.name === 'messages:unreadItem')
    if (!unread) throw new Error('no unread write went out')
    snap.messages = snap.messages.map(({ read_at: _, ...m }) => m)
    await act(async () => publish())
    await act(async () => unread.answer())
    await settle()
    await setVisibility('hidden')
    await setVisibility('visible')
    await comments(range(1, 8))
    expect(P.inboxItem?.item).toMatchObject({ unread_count: 1 })
    expect(thread()).not.toContain('New')
    expect(itemReads()).toEqual([])
  })

  it('freezes a window opened while hidden on its first answer after the page shows', async () => {
    await load([message('task-a', 5)])
    await setVisibility('hidden')
    await openTask()
    expect(itemReads()).toEqual([])
    expect(threads.filter((t) => !t.closed)).toEqual([])
    await setVisibility('visible')
    await comments(range(1, 8))
    expect(thread().indexOf('New')).toBe(4)
    expect(itemReads()).toHaveLength(1)
  })

  it('keeps the start of nothing it was given on a return with news', async () => {
    await load()
    const { IssueDetail } = await import('./IssueDetail')
    const row = snap.issues.find((it) => it.id === 'task-a')
    if (!row) throw new Error('missing task-a')
    const task = { id: P.openTask(row.id, row.org_id, row.num) }
    await act(async () =>
      root.render(
        <TooltipProvider>
          <IssueDetail
            issueId={task.id}
            onClose={vi.fn()}
            onOpen={vi.fn()}
            unread={{ ts: null, change: false }}
          />
        </TooltipProvider>,
      ),
    )
    await settle()
    await comments(range(1, 5))
    await setVisibility('hidden')
    beyond = [message('task-a', 6)]
    await act(async () => publish())
    await setVisibility('visible')
    await comments(range(1, 7))
    expect(thread()).not.toContain('New')
  })
})
