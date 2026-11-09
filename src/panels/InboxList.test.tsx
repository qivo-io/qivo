// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import type { ForcedInbox } from '../store/inboxStandIn.setup'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'
import type { Row } from '../store/rows'

/* The Inbox list on the server's pages (convex/inbox.ts page), on the real
   store over the live double, which answers the page from the published
   whole through its stand-in (store/inboxStandIn.setup.ts), at desktop
   width unless a case takes a phone's. It shows one page of up to 50
   task groups across the login's seats in the server's order, with the
   filters and the search as the page's arguments, Previous and Next over
   the page's cursors with only the page on screen held, and notes that
   say only what the answer says. Row actions name their item by
   organization and task with the row's cutoff and show at once through
   the store's marks, which end once a current answer holds the write, or
   once an Inbox mounts afresh for a write settled while none showed. The
   server here answers a write after it sent the page the write changed,
   as Convex does, unless a case holds the write. Each case raises at most
   one figure to its design size. An everyday Inbox is 60 groups over 3
   sub-projects, and the figures are one sub-project's 300 open and 150
   Done tasks and one project's 800 open and 200 Done tasks over 3
   sub-projects, a group each; stops and bounds come from lowering the
   stand-in's examine budget and PAGE_LIMITS.starts. */

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

type Store = typeof import('../store/planner')

const AT = Date.parse('2026-09-14T08:00:00.000Z')
const GUEST = 'org-guest'
const minute = (n: number) => new Date(AT - n * 60_000).toISOString()

let container: HTMLDivElement
let root: Root
let snap: Snapshot
let store: Store
let publishWhole: () => void = () => {}
// the page reads the Inbox opened, with their arguments and whether open
let pageWatches: { args: Record<string, unknown>; open: boolean }[]
// the writes a case holds, which it answers or refuses
let held: {
  name: string
  args: Record<string, unknown>
  answer: () => void
  refuse: () => void
}[]
let holding: boolean
// what Open task in board asked App to open
let boardOpens: { project: string; open: string }[]
// the tasks the Inbox opened in its pane
let opened: (string | null)[]
// shows or hides the kept Inbox
let showKept: (shown: boolean) => void
// renders the Inbox openInbox rendered, on the same store, as into a fresh
// root after remount()
let mountInbox: () => Promise<void> = async () => {}
// the live double's own watch, which the spy below wraps
let realWatch: Double['watch'] | null = null

/* ------------------------------------------------------------- fixtures */

/** A project of the fixture's organization, or of `org`. */
function project(id: string, name: string, over: Partial<Row<'projects'>> = {}) {
  const base = snap.projects[0]
  const row: Row<'projects'> = {
    ...base,
    id,
    name,
    key: id.slice(0, 4).toUpperCase(),
    num: snap.projects.length + 10,
    ...over,
  }
  snap.projects.push(row)
  return row
}

/** The second seat, in organization GUEST, with a project of its own. */
function guestSeat() {
  const me = snap.profiles[0]
  snap.orgs.push({ ...snap.orgs[0], id: GUEST, slug: 'guest', name: 'Guest Co' })
  snap.profiles.push({ ...me, id: 'me-guest', org_id: GUEST, org_role: 'guest' })
  snap.myProfileIds.push('me-guest')
  project('guest-work', 'Guest work', { org_id: GUEST })
}

/** The seat's profile in organization `org`. */
const seatOf = (org: string) => (org === GUEST ? 'me-guest' : snap.profiles[0].id)

/** A task `n` in project `projectId` of organization `org`, with one
    message at `n` minutes before the start, newest first by `n`. */
function group(
  n: number,
  projectId: string,
  over: {
    org?: string
    uuid?: string
    title?: string
    status?: Row<'issues'>['status']
    message?: Partial<Row<'messages'>>
    beyond?: boolean
  } = {},
) {
  const org = over.org ?? snap.orgs[0].id
  const uuid = over.uuid ?? `task-${org === GUEST ? 'g' : 'a'}-${String(n).padStart(4, '0')}`
  snap.issues.push({
    id: uuid,
    org_id: org,
    project_id: projectId,
    num: n + 1,
    title: over.title ?? `Task ${n}`,
    description: '',
    status: over.status ?? 'progress',
    priority: 'medium',
    paused: false,
    created_at: minute(n),
    updated_at: minute(n),
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  const message: Row<'messages'> = {
    id: `message-${org}-${uuid}`,
    org_id: org,
    recipient_id: seatOf(org),
    issue_id: uuid,
    issue_title: over.title ?? `Task ${n}`,
    kind: 'comment',
    detail: 'New comment',
    created_at: minute(n),
    ...over.message,
  }
  if (over.beyond) beyondCut.push(message)
  else snap.messages.push(message)
  return uuid
}
// more messages the server holds, which a case plants apart from the rest
let beyondCut: Row<'messages'>[]

/** Applies write `name` with `args` to the server as the server does,
    and sends the workspace before the write's answer, as Convex sends the
    results a write changed first. */
function serverWrite(name: string, args: Record<string, unknown>) {
  const ofItem = (m: Row<'messages'>) => m.issue_id === args.issue_id && m.org_id === args.org_id
  const through = typeof args.through === 'number' ? args.through : Number.POSITIVE_INFINITY
  const upTo = (m: Row<'messages'>) => Date.parse(m.created_at) <= through
  const change = (fn: (m: Row<'messages'>) => Row<'messages'> | null) => {
    const apply = (list: Row<'messages'>[]) =>
      list.flatMap((m) => {
        if (!ofItem(m)) return [m]
        const next = fn(m)
        return next ? [next] : []
      })
    snap.messages = apply(snap.messages)
    beyondCut = apply(beyondCut)
  }
  if (name === 'messages:readItem')
    change((m) => (upTo(m) ? { ...m, read_at: m.read_at ?? minute(-1) } : m))
  else if (name === 'messages:unreadItem') change((m) => ({ ...m, read_at: undefined }))
  else if (name === 'messages:removeItem') change((m) => (upTo(m) ? null : m))
  else if (name === 'messages:snoozeItem')
    change((m) => ({
      ...m,
      read_at: undefined,
      snoozed_until: (args.until as string | null) ?? undefined,
    }))
  else if (name === 'messages:markAllRead') {
    snap.messages = snap.messages.map((m) =>
      m.org_id === args.org_id && !m.snoozed_until ? { ...m, read_at: m.read_at ?? minute(-1) } : m,
    )
    publishWhole()
    return { marked: 1, ids: [], hasMore: false, before: 1 }
  } else return null
  publishWhole()
  return null
}

/** Loads the store with the whole `plant` builds, and renders the Inbox
    as App holds it, in a kept view with `kept`. `tasks` false boots a
    session that never asked for every task, so the workspace holds none. */
async function openInbox(
  plant: () => void,
  { tasks = true, kept = false }: { tasks?: boolean; kept?: boolean } = {},
) {
  vi.resetModules()
  double.live?.forceInbox(null)
  snap = plannerFixture()
  beyondCut = []
  project('atlas', 'Atlas', { type: 'meta' })
  plant()
  pageWatches = []
  held = []
  holding = false
  boardOpens = []
  opened = []
  network.onUpdate.mockImplementation((ref, _args, next) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      publishWhole = () =>
        next(structuredClone({ ...snap, messages: [...snap.messages, ...beyondCut] }))
      publishWhole()
    } else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    return () => {}
  })
  network.query.mockReset()
  network.query.mockImplementation(async (ref) =>
    getFunctionName(ref) === 'messages:bulkReach'
      ? { seats: snap.orgs.map((o) => ({ org_id: o.id, reach: 'one', before: 1 })) }
      : null,
  )
  network.mutation.mockReset()
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (holding && name.startsWith('messages:'))
      return new Promise((resolve, reject) =>
        held.push({
          name,
          args,
          answer: () => resolve(serverWrite(name, args)),
          refuse: () => reject(new ConvexError({ code: 'forbidden', message: 'No access' })),
        }),
      )
    return Promise.resolve(serverWrite(name, args))
  })
  const { TASKS } = await import('../store/liveParts')
  TASKS.atBoot = tasks
  store = await import('../store/planner')
  watchPages()
  await store.initStore()
  const { Inbox } = await import('./Inbox')
  const { usePlannerVersion } = await import('../store/usePlannerVersion')
  const { KeptView } = await import('../components/KeptView')
  function InboxHost() {
    usePlannerVersion()
    const [openIssue, setOpenIssue] = useState<string | null>(null)
    return (
      <Inbox
        showOnBoard={(project: string, open: string) => boardOpens.push({ project, open })}
        onExit={vi.fn()}
        openTask={(next: string | null) => {
          opened.push(next)
          setOpenIssue(next)
        }}
        openIssue={openIssue}
        onPlanOnRoadmap={vi.fn()}
      />
    )
  }
  function KeptHost() {
    const [shown, setShown] = useState(true)
    useEffect(() => {
      showKept = setShown
    }, [])
    return (
      <KeptView view="inbox" shown={shown} className="view">
        <InboxHost />
      </KeptView>
    )
  }
  mountInbox = () =>
    act(async () =>
      root.render(<TooltipProvider>{kept ? <KeptHost /> : <InboxHost />}</TooltipProvider>),
    )
  await mountInbox()
  await settle()
}

/** Records the Inbox page reads the store and the views watch through the
    live double, which its mock makes as the store loads it. */
function watchPages() {
  const live = double.live
  if (!live) throw new Error('no live double')
  if (!vi.isMockFunction(live.watch)) realWatch = live.watch
  const watch = realWatch
  if (!watch) throw new Error('no watch to wrap')
  vi.spyOn(live, 'watch').mockImplementation((ref, args, sharing) => {
    const w = watch.call(live, ref, args, sharing)
    if (getFunctionName(ref) !== 'inbox:page') return w
    const entry = { args: args as Record<string, unknown>, open: true }
    pageWatches.push(entry)
    return {
      ...w,
      stop: () => {
        entry.open = false
        w.stop()
      },
    }
  })
}

/* -------------------------------------------------------------- helpers */

const settle = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
const until = (check: () => void) =>
  act(async () => {
    await vi.waitFor(check)
  })
const rows = () => [...container.querySelectorAll<HTMLElement>('[data-message-key]')]
const titles = () => rows().map((row) => row.querySelector('[data-msg-title]')?.textContent)
const fold = () => container.querySelector<HTMLElement>('[data-inbox-page-end]')
const openPages = () => pageWatches.filter((w) => w.open)
const lastAsk = () => openPages().at(-1)?.args
const button = (selector: string) => container.querySelector<HTMLButtonElement>(selector)
/** The menu item that reads `text`, in any open menu. */
const item = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  )

async function press(element: Element | null | undefined) {
  if (!element) throw new Error('nothing to press')
  await act(async () => (element as HTMLElement).click())
  await settle()
}
/** Presses Next and waits until the move ends. */
async function next() {
  await press(button('[data-inbox-page-next]'))
  await until(() =>
    expect(button('[data-inbox-page-next]')?.textContent ?? 'Next').not.toBe('Loading…'),
  )
}
async function previous() {
  await press(button('[data-inbox-page-previous]'))
  await settle()
}
/** Opens the row menu of the row `key` names. */
async function rowMenu(key: string) {
  const row = container.querySelector(`[data-message-key="${key}"]`)
  if (!row) throw new Error(`no row ${key}`)
  await act(async () => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  if (!document.querySelector('[data-msg-menu]')) throw new Error('the row menu did not open')
}
/** Toggles the filter menu's item `text`, opening the menu first when it
    is closed; it stays open, as after a person's press. */
async function filter(text: string) {
  if (!item(text)) await press(button('[data-inbox-filter]'))
  await press(item(text))
}
/** Mounts a fresh root, for a case that opens the Inbox again. */
async function remount() {
  await act(async () => root.unmount())
  root = createRoot(container)
}
/** Types `text` into the desktop search and waits for typing to rest. */
async function search(text: string) {
  const input = container.querySelector<HTMLInputElement>('[data-inbox-search]')
  if (!input) throw new Error('missing the search')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(() => new Promise((resolve) => setTimeout(resolve, 300)))
  await settle()
}
async function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await settle()
}
const key = (uuid: string, org = snap.orgs[0].id) => `${org}:${uuid}`

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
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
  vi.spyOn(console, 'error').mockImplementation(() => {})
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  double.live?.forceInbox(null)
  if (double.live) double.live.inboxStandIn.examine = Number.POSITIVE_INFINITY
  const { PAGE_LIMITS } = await import('../lib/pagedList')
  PAGE_LIMITS.starts = 1000
  Reflect.deleteProperty(document, 'visibilityState')
  container.remove()
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/* ------------------------------------------------------------ the cases */

/** The everyday Inbox: 60 groups over 3 sub-projects, two of the
    fixture's organization under Atlas and one of the guest seat's. */
function everyday() {
  guestSeat()
  project('firmware', 'Firmware', { parent_id: 'atlas' })
  project('board', 'Board rev', { parent_id: 'atlas' })
  project('guest-sub', 'Guest sub', { parent_id: 'guest-work', org_id: GUEST })
  for (let n = 0; n < 60; n++) {
    const place = ['firmware', 'board', 'guest-sub'][n % 3]
    group(n, place, { org: place === 'guest-sub' ? GUEST : undefined })
  }
}

describe('the Inbox list', { timeout: 30_000 }, () => {
  it('shows the everyday Inbox a page of 50 from the server, with Next and Previous, asking for no task', async () => {
    await openInbox(
      () => {
        everyday()
        // a second unread update on the newest group
        snap.messages.push({ ...snap.messages[0], id: 'message-extra', created_at: minute(-1) })
      },
      { tasks: false },
    )
    await until(() => expect(rows()).toHaveLength(50))
    expect(titles().slice(0, 3)).toEqual(['Task 0', 'Task 1', 'Task 2'])
    // every row says where it is, a sub-project after its project, from the
    // page, though the workspace holds no task
    const crumbs = (n: number) =>
      [...rows()[n].querySelectorAll('[data-msg-crumb]')].map((c) => c.textContent)
    expect(crumbs(0)).toEqual(['Atlas', 'Firmware'])
    expect(crumbs(2)).toEqual(['Guest work', 'Guest sub'])
    expect(rows()[2].dataset.messageOrg).toBe(GUEST)
    expect(rows()[0].querySelector('[data-msg-count]')?.textContent).toBe('2')
    expect(rows()[1].querySelector('[data-msg-age]')?.textContent).toMatch(/^\d+[mhd]$|^now$/)
    expect(fold()?.dataset.inboxPageEnd).toBe('more')
    await next()
    await until(() => expect(rows()).toHaveLength(10))
    expect(titles()[0]).toBe('Task 50')
    expect(fold()?.dataset.inboxPageEnd).toBe('end')
    expect(button('[data-inbox-page-next]')).toBeNull()
    await previous()
    await until(() => expect(rows()).toHaveLength(50))
    expect(titles()[0]).toBe('Task 0')
    expect(button('[data-inbox-page-previous]')).toBeNull()
    // one page read at a time, read open, and no task asked for
    expect(openPages()).toHaveLength(1)
    expect(pageWatches.every((w) => !('through' in w.args))).toBe(true)
    expect(store.__layerProbe?.asks()).toEqual([])
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
  })

  it("pages one sub-project's 450 groups to the end and back, holding one page", async () => {
    await openInbox(
      () => {
        project('firmware', 'Firmware', { parent_id: 'atlas' })
        for (let n = 0; n < 450; n++)
          group(n, 'firmware', {
            beyond: true,
            status: n % 3 === 2 ? 'done' : 'progress',
            message:
              n === 7
                ? { snoozed_until: '2026-09-20T08:00:00.000Z' }
                : n % 9 === 4
                  ? { kind: 'mention', detail: 'mentioned you in a comment' }
                  : n % 2
                    ? { read_at: minute(-1) }
                    : {},
          })
      },
      { tasks: false },
    )
    await until(() => expect(rows()).toHaveLength(50))
    const seen = new Set(rows().map((row) => row.dataset.messageKey))
    for (let page = 2; page <= 9; page++) {
      await next()
      await until(() => expect(rows()[0].dataset.messageKey).not.toBe(key('task-a-0000')))
      expect(rows().length).toBeLessThanOrEqual(50)
      for (const row of rows()) seen.add(row.dataset.messageKey)
      expect(openPages()).toHaveLength(1)
    }
    // every unsnoozed group, once, and the list's end
    expect(seen.size).toBe(449)
    expect(fold()?.dataset.inboxPageEnd).toBe('end')
    expect(container.textContent).not.toContain('Older messages are not listed')
    for (let page = 8; page >= 1; page--) await previous()
    await until(() => expect(titles()[0]).toBe('Task 0'))
    expect(button('[data-inbox-page-previous]')).toBeNull()
    // Oldest first, Unread only, Mentions and Show snoozed are the page's
    // arguments, and each starts again at the first page
    await next()
    await press(button('[aria-label="Message order"]'))
    await press(item('Oldest first'))
    await until(() => expect(titles()[0]).toBe('Task 449'))
    expect(lastAsk()).toEqual({
      order: 'oldest',
      unread_only: false,
      include_snoozed: false,
      kinds: [],
    })
    expect(button('[data-inbox-page-previous]')).toBeNull()
    await filter('Unread only')
    await until(() => expect(lastAsk()).toMatchObject({ order: 'oldest', unread_only: true }))
    await until(() => expect(rows().every((row) => row.hasAttribute('data-unread'))).toBe(true))
    await filter('Mentions')
    await until(() => expect(lastAsk()).toMatchObject({ kinds: ['mention'] }))
    await until(() => expect(rows().every((row) => row.dataset.kinds === 'mention')).toBe(true))
    await filter('Unread only')
    await filter('Mentions')
    await filter('Show snoozed')
    await until(() => expect(lastAsk()).toMatchObject({ include_snoozed: true, kinds: [] }))
    // the snoozed group shows with its return, oldest first near the end
    await press(button('[aria-label="Message order"]'))
    await press(item('Newest first'))
    await until(() => expect(container.querySelector('[data-msg-until]')).not.toBeNull())
    expect(
      container.querySelector('[data-msg-until]')?.closest<HTMLElement>('[data-message]')?.dataset
        .message,
    ).toBe('task-a-0007')
  })

  it("searches one project's 1,000 groups on the server, says how far each stopped page looked, and finds a row the workspace does not hold", async () => {
    await openInbox(
      () => {
        for (const [id, name] of [
          ['firmware', 'Firmware'],
          ['board', 'Board rev'],
          ['docs', 'Docs'],
        ])
          project(id, name, { parent_id: 'atlas' })
        for (let n = 0; n < 1000; n++)
          group(n, ['firmware', 'board', 'docs'][n % 3], {
            title: n === 999 ? 'Zephyr calibration' : `Task ${n}`,
            status: n % 5 === 4 ? 'done' : 'progress',
          })
      },
      { tasks: false },
    )
    const live = double.live
    if (!live) throw new Error('no live double')
    live.inboxStandIn.examine = 100
    await until(() => expect(rows()).toHaveLength(50))
    // the browse stops at 50 rows, a full page
    expect(fold()?.dataset.inboxPageEnd).toBe('more')
    await search('zephyr')
    expect(lastAsk()).toMatchObject({ search: 'zephyr' })
    await until(() => expect(fold()?.textContent).toContain('Next looks further.'))
    // each stopped page says how far it searched, and never that nothing matches
    let pages = 1
    while (rows().length === 0) {
      await until(() => expect(fold()?.textContent).toContain('Next looks further.'))
      expect(fold()?.textContent).toMatch(/^No matches yet in your messages back to .+\. Next/)
      expect(container.textContent).not.toContain('No messages match the filters.')
      await next()
      pages++
      if (pages > 12) throw new Error('the search never reached the oldest group')
    }
    expect(pages).toBe(10)
    expect(titles()).toEqual(['Zephyr calibration'])
    // by a task ID and by a sub-project's name, rows the workspace does not hold
    await search('QN-3')
    await until(() => expect(titles()).toContain('Task 2'))
    await search('Docs')
    await until(() => expect(rows().length).toBeGreaterThan(0))
    expect(
      rows().every((row) =>
        [...row.querySelectorAll('[data-msg-crumb]')].some((c) => c.textContent === 'Docs'),
      ),
    ).toBe(true)
    expect(store.__layerProbe?.asks()).toEqual([])
    // past 200 characters it asks nothing new and says the limit
    const asked = pageWatches.length
    await search('x'.repeat(201))
    expect(fold()?.dataset.inboxPageEnd).toBe('too_long')
    expect(fold()?.textContent).toContain('A search must be at most 200 characters.')
    expect(pageWatches.slice(asked).some((w) => String(w.args.search).length > 200)).toBe(false)
    // a blank search sends none
    await search('   ')
    await until(() => expect(lastAsk()).not.toHaveProperty('search'))
  })
})

describe("the Inbox page's notes", { timeout: 30_000 }, () => {
  /** Opens the everyday Inbox with the page forced to `force`. */
  async function forced(force: ForcedInbox, plant = everyday) {
    await openInbox(() => {
      plant()
      double.live?.forceInbox(force, 'inbox:page')
    })
  }

  it('says it loads, and that it failed with Try again, which reads again', async () => {
    await forced('loading')
    expect(fold()?.dataset.inboxPageEnd).toBe('loading')
    expect(fold()?.textContent).toBe('Loading messages…')
    expect(container.querySelector('[data-inbox-page-state]')?.getAttribute('aria-busy')).toBe(
      'true',
    )
    await act(async () => double.live?.forceInbox('failed', 'inbox:page'))
    await settle()
    await until(() => expect(fold()?.dataset.inboxPageEnd).toBe('failed'))
    expect(fold()?.textContent).toContain("Couldn't load your messages.")
    // Try again subscribes afresh, and the page answers once it can
    await press(item('Try again'))
    await until(() => expect(fold()?.dataset.inboxPageEnd).toBe('failed'))
    await act(async () => double.live?.forceInbox(null))
    await until(() => expect(rows()).toHaveLength(50))
  })

  it("names an organization whose messages are being prepared beside the other seat's rows, and a group a check left out", async () => {
    await forced('notReady')
    await until(() => expect(rows().length).toBeGreaterThan(0))
    expect(container.querySelector('[data-inbox-note="not-ready"]')?.textContent).toBe(
      'Messages in Testbed Labs are still being prepared and are not listed yet.',
    )
    expect(rows().every((row) => row.dataset.messageOrg === GUEST)).toBe(true)
    await act(async () => double.live?.forceInbox('unchecked', 'inbox:page'))
    await settle()
    await until(() =>
      expect(container.querySelector('[data-inbox-note="unchecked"]')?.textContent).toBe(
        'Some messages could not be checked and are not listed.',
      ),
    )
    // above rows the note is the sentence alone; the live page runs again
    expect(container.querySelector('[data-inbox-note="unchecked"] button')).toBeNull()
  })

  it('says a page with no rows and a seat being prepared in place of the page, with Retry, never empty', async () => {
    await forced('notReady', () => {
      project('firmware', 'Firmware', { parent_id: 'atlas' })
      for (let n = 0; n < 3; n++) group(n, 'firmware')
    })
    await until(() => expect(fold()?.dataset.inboxPageEnd).toBe('held'))
    expect(fold()?.textContent).toContain(
      'Messages in Testbed Labs are still being prepared and are not listed yet.',
    )
    expect(fold()?.querySelector('[data-page-retry]')).not.toBeNull()
    expect(container.textContent).not.toContain('No messages yet.')
  })

  it('says a stop that cannot say how far it looked, and a page that cannot move on with Retry', async () => {
    await forced('blind')
    await until(() =>
      expect(fold()?.textContent).toContain(
        'Qivo looked through part of your Inbox. Next looks further.',
      ),
    )
    await act(async () => double.live?.forceInbox(null))
    await until(() => expect(rows()).toHaveLength(50))
    await act(async () => double.live?.forceInbox('stuck', 'inbox:page'))
    await next()
    await until(() => expect(fold()?.dataset.inboxPageEnd).toBe('stuck'))
    expect(fold()?.textContent).toContain("Qivo couldn't look further through your Inbox.")
    expect(fold()?.querySelector('[data-page-retry]')).not.toBeNull()
  })

  it('starts again at the first page when the server refuses a cursor, then fails on a second refusal', async () => {
    await forced('badCursor')
    await until(() => expect(rows()).toHaveLength(50))
    await next()
    await until(() => expect(titles()[0]).toBe('Task 0'))
    expect(button('[data-inbox-page-previous]')).toBeNull()
    await next()
    await until(() => expect(fold()?.dataset.inboxPageEnd).toBe('failed'))
    expect(fold()?.textContent).toContain("Couldn't load your messages.")
  })

  it('says no messages yet, no match, no more and that snoozed ones show with Show snoozed only on a complete answer', async () => {
    // none at all
    await openInbox(() => {})
    await until(() => expect(fold()?.textContent).toBe('No messages yet.'))
    expect(fold()?.parentElement?.hasAttribute('data-inbox-empty')).toBe(true)
    // only read groups under Unread only
    await remount()
    await openInbox(() => {
      project('firmware', 'Firmware', { parent_id: 'atlas' })
      group(0, 'firmware', { message: { read_at: minute(-1) } })
    })
    await until(() => expect(rows()).toHaveLength(1))
    await filter('Unread only')
    await until(() => expect(fold()?.textContent).toBe('No messages match the filters.'))
    // only snoozed groups, with Show snoozed off
    await remount()
    await openInbox(() => {
      project('firmware', 'Firmware', { parent_id: 'atlas' })
      group(0, 'firmware', { message: { snoozed_until: '2026-09-20T08:00:00.000Z' } })
    })
    await until(() =>
      expect(fold()?.textContent).toBe('No messages to show. Snoozed ones show with Show snoozed.'),
    )
    await filter('Show snoozed')
    await until(() => expect(rows()).toHaveLength(1))
    // a later page that nothing more fills
    await remount()
    await openInbox(() => {
      project('firmware', 'Firmware', { parent_id: 'atlas' })
      for (let n = 0; n < 51; n++) group(n, 'firmware')
    })
    await until(() => expect(rows()).toHaveLength(50))
    await next()
    await until(() => expect(rows()).toHaveLength(1))
    snap.messages = snap.messages.filter((m) => m.issue_id !== 'task-a-0050')
    await act(async () => publishWhole())
    await until(() => expect(fold()?.textContent).toContain('No more messages.'))
  })
})

describe("the Inbox's row actions", { timeout: 30_000 }, () => {
  /** Five groups of Firmware, task-a-0002 read. */
  function five() {
    project('firmware', 'Firmware', { parent_id: 'atlas' })
    for (let n = 0; n < 5; n++)
      group(n, 'firmware', { message: n === 2 ? { read_at: minute(-1) } : {} })
  }
  const row = (uuid: string) => container.querySelector<HTMLElement>(`[data-message="${uuid}"]`)

  it('reads, unreads, removes and snoozes the row’s item by its organization, task and cutoff, at once', async () => {
    await openInbox(five, { tasks: false })
    await until(() => expect(rows()).toHaveLength(5))
    holding = true
    const org = snap.orgs[0].id
    const through = (n: number) => Date.parse(minute(n))
    // Mark as read, read at once, and still once the answer comes
    await rowMenu(key('task-a-0000'))
    await press(item('Mark as read'))
    expect(held.at(-1)).toMatchObject({
      name: 'messages:readItem',
      args: { org_id: org, issue_id: 'task-a-0000', through: through(0) },
    })
    expect(row('task-a-0000')?.hasAttribute('data-unread')).toBe(false)
    await act(async () => held.at(-1)?.answer())
    await settle()
    expect(row('task-a-0000')?.hasAttribute('data-unread')).toBe(false)
    // a refused read brings the unread row back
    await rowMenu(key('task-a-0001'))
    await press(item('Mark as read'))
    expect(row('task-a-0001')?.hasAttribute('data-unread')).toBe(false)
    await act(async () => held.at(-1)?.refuse())
    await settle()
    expect(row('task-a-0001')?.hasAttribute('data-unread')).toBe(true)
    // Mark as unread of the read row
    await rowMenu(key('task-a-0002'))
    await press(item('Mark as unread'))
    expect(held.at(-1)).toMatchObject({
      name: 'messages:unreadItem',
      args: { org_id: org, issue_id: 'task-a-0002' },
    })
    expect(row('task-a-0002')?.hasAttribute('data-unread')).toBe(true)
    await act(async () => held.at(-1)?.answer())
    // Remove hides the row at once, and a refusal brings it back
    await rowMenu(key('task-a-0003'))
    await press(item('Remove notification'))
    expect(held.at(-1)).toMatchObject({
      name: 'messages:removeItem',
      args: { org_id: org, issue_id: 'task-a-0003', through: through(3) },
    })
    expect(row('task-a-0003')).toBeNull()
    await act(async () => held.at(-1)?.refuse())
    await settle()
    expect(row('task-a-0003')).not.toBeNull()
    // Snooze hides it unless Show snoozed is on, and Unsnooze sends null
    await rowMenu(key('task-a-0004'))
    await press(container.ownerDocument.querySelector('[data-msg-snooze-go]'))
    const snooze = held.at(-1)
    expect(snooze).toMatchObject({
      name: 'messages:snoozeItem',
      args: { org_id: org, issue_id: 'task-a-0004' },
    })
    expect(typeof snooze?.args.until).toBe('string')
    expect(row('task-a-0004')).toBeNull()
    await act(async () => snooze?.answer())
    await settle()
    holding = false
    await filter('Show snoozed')
    await until(() => expect(row('task-a-0004')?.querySelector('[data-msg-until]')).not.toBeNull())
    await rowMenu(key('task-a-0004'))
    await press(document.querySelector('[data-msg-menu-unsnooze]'))
    await until(() => expect(row('task-a-0004')?.querySelector('[data-msg-until]')).toBeNull())
    expect(
      (network.mutation.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined)?.until,
    ).toBeNull()
    // nothing sent message ids
    expect(
      network.mutation.mock.calls.some(
        ([, args]) => 'ids' in ((args ?? {}) as Record<string, unknown>),
      ),
    ).toBe(false)
  })

  it('keeps the cutoff the menu opened with when news arrives on the row, which stays unread', async () => {
    await openInbox(five, { tasks: false })
    await until(() => expect(rows()).toHaveLength(5))
    await rowMenu(key('task-a-0001'))
    // news on the row while its menu is open moves it to the top
    snap.messages.push({ ...snap.messages[1], id: 'news', created_at: minute(-5) })
    await act(async () => publishWhole())
    await until(() => expect(rows()[0].dataset.message).toBe('task-a-0001'))
    holding = true
    await press(item('Mark as read'))
    expect(held.at(-1)).toMatchObject({
      name: 'messages:readItem',
      args: { issue_id: 'task-a-0001', through: Date.parse(minute(1)) },
    })
    // while the read waits, its mark of the old cutoff leaves the row with
    // news as the page shows it, unread
    expect(row('task-a-0001')?.hasAttribute('data-unread')).toBe(true)
    // the server read up to the cutoff, and the news stays unread
    await act(async () => held.at(-1)?.answer())
    await settle()
    await until(() => expect(row('task-a-0001')?.hasAttribute('data-unread')).toBe(true))
    expect(row('task-a-0001')?.dataset.count).toBe('1')
  })

  it('shows one task id of two organizations as two rows, each acting on and opening its own', async () => {
    await openInbox(
      () => {
        guestSeat()
        project('firmware', 'Firmware', { parent_id: 'atlas' })
        group(0, 'firmware', { uuid: 'shared-task' })
        group(1, 'guest-work', { uuid: 'shared-task', org: GUEST })
      },
      { tasks: false },
    )
    await until(() => expect(rows()).toHaveLength(2))
    expect(rows().map((r) => r.dataset.message)).toEqual(['shared-task', 'shared-task'])
    const orgs = rows().map((r) => r.dataset.messageOrg)
    expect(orgs).toEqual([snap.orgs[0].id, GUEST])
    for (const org of orgs) {
      await rowMenu(key('shared-task', org))
      await press(item('Mark as read'))
    }
    const reads = network.mutation.mock.calls
      .filter(([ref]) => getFunctionName(ref) === 'messages:readItem')
      .map(([, args]) => (args as { org_id: string }).org_id)
    expect(reads).toEqual(orgs)
    const { refParts } = await import('../lib/taskReference')
    for (const org of orgs) {
      const open = container.querySelector<HTMLElement>(
        `[data-message-key="${key('shared-task', org)}"] .inbox-message-open`,
      )
      await press(open)
      expect(refParts(opened.at(-1))).toMatchObject({ org, uuid: 'shared-task' })
    }
  })

  it('opens a held task of another organization of the same id by its own reference, not the handle', async () => {
    await openInbox(() => {
      guestSeat()
      project('firmware', 'Firmware', { parent_id: 'atlas' })
      group(0, 'firmware', { uuid: 'shared-task' })
      // the guest seat's task of the same id, which the parts do not send
      const before = snap.issues.length
      group(1, 'guest-work', { uuid: 'shared-task', org: GUEST })
      const [guestTask] = snap.issues.splice(before, 1)
      Object.assign(snap, { unheld: { issues: [guestTask] } })
    })
    await until(() => expect(rows()).toHaveLength(2))
    const guestOpen = container.querySelector<HTMLElement>(
      `[data-message-key="${key('shared-task', GUEST)}"] .inbox-message-open`,
    )
    await press(guestOpen)
    const { refParts } = await import('../lib/taskReference')
    expect(refParts(opened.at(-1))).toEqual({ org: GUEST, num: 2, uuid: 'shared-task' })
    const homeOpen = container.querySelector<HTMLElement>(
      `[data-message-key="${key('shared-task')}"] .inbox-message-open`,
    )
    await press(homeOpen)
    expect(opened.at(-1)).toBe(store.P.handleOf('shared-task'))
  })

  it('marks the rows shown by Mark all as read at once, and brings back a refused seat’s rows', async () => {
    await openInbox(everyday, { tasks: false })
    await until(() => expect(rows()).toHaveLength(50))
    holding = true
    await press(button('[data-inbox-mark-all-read]'))
    await until(() => expect(held.filter((w) => w.name === 'messages:markAllRead')).toHaveLength(2))
    expect(container.querySelectorAll('[data-message][data-unread]')).toHaveLength(0)
    const bySeat = (org: string) =>
      held.find((w) => w.name === 'messages:markAllRead' && w.args.org_id === org)
    await act(async () => bySeat(GUEST)?.refuse())
    await settle()
    // the guest seat's rows show unread again, the other seat's stay read
    await until(() =>
      expect(
        rows()
          .filter((r) => r.dataset.messageOrg === GUEST)
          .every((r) => r.hasAttribute('data-unread')),
      ).toBe(true),
    )
    await act(async () => bySeat(snap.orgs[0].id)?.answer())
    await settle()
    expect(
      rows()
        .filter((r) => r.dataset.messageOrg !== GUEST)
        .some((r) => r.hasAttribute('data-unread')),
    ).toBe(false)
  })

  it('offers Open task in board for a task the workspace does not hold, by its reference, on every row with a project', async () => {
    await openInbox(
      () => {
        project('firmware', 'Firmware', { parent_id: 'atlas' })
        group(0, 'firmware')
        group(1, 'elsewhere')
        // a project the store does not hold, which the Board needs
        Object.assign(snap, {
          unheld: {
            projects: [{ ...snap.projects[0], id: 'elsewhere', name: 'Elsewhere', num: 77 }],
          },
        })
      },
      { tasks: false },
    )
    await until(() => expect(rows()).toHaveLength(2))
    await rowMenu(key('task-a-0000'))
    await press(document.querySelector('[data-msg-menu-board]'))
    expect(boardOpens).toHaveLength(1)
    expect(boardOpens[0].project).toBe('firmware')
    const { refParts } = await import('../lib/taskReference')
    expect(refParts(boardOpens[0].open)).toEqual({
      org: snap.orgs[0].id,
      num: 1,
      uuid: 'task-a-0000',
    })
    // App reveals the card the Board names it by, its handle
    expect(store.P.handleOfOpen(boardOpens[0].open)).toBe('QN-1')
    // a row whose project the store has not named is offered too, and the
    // open rule's own check decides whether it opens (App)
    await rowMenu(key('task-a-0001'))
    await press(document.querySelector('[data-msg-menu-board]'))
    expect(boardOpens).toHaveLength(2)
    expect(boardOpens[1].project).toBe('elsewhere')
  })
})

describe('the Inbox list around its page', { timeout: 30_000 }, () => {
  it('keeps the pane on its task, with a comment typed in it, across Next, Previous and a filter, and lights the row by organization and task', async () => {
    await openInbox(everyday)
    await until(() => expect(rows()).toHaveLength(50))
    await press(rows()[0].querySelector('.inbox-message-open'))
    const pane = () => container.querySelector('.inbox-detail-frame [role="region"]')
    await until(() => expect(pane()).not.toBeNull())
    const first = pane()
    const composer = await act(async () =>
      vi.waitFor(() => {
        const found = document.querySelector<HTMLElement & { editor?: unknown }>(
          '[role="textbox"][aria-label="Leave a comment"]',
        )
        if (!found) throw new Error('no composer')
        return found as unknown as {
          editor: { commands: { insertContent(text: string): void }; getText(): string }
        }
      }),
    )
    await act(async () => composer.editor.commands.insertContent('Check the rev B board'))
    const lit = () =>
      rows()
        .filter((r) => r.hasAttribute('data-selected'))
        .map((r) => r.dataset.messageKey)
    expect(lit()).toEqual([key('task-a-0000')])
    await next()
    await previous()
    await filter('Unread only')
    expect(pane()).toBe(first)
    expect(composer.editor.getText()).toBe('Check the rev B board')
  })

  it('reads nothing while the tab is hidden, keeps its rows and marks, and reads again on return', async () => {
    await openInbox(() => {
      project('firmware', 'Firmware', { parent_id: 'atlas' })
      for (let n = 0; n < 5; n++) group(n, 'firmware')
    })
    await until(() => expect(rows()).toHaveLength(5))
    holding = true
    await rowMenu(key('task-a-0000'))
    await press(item('Remove notification'))
    expect(rows()).toHaveLength(4)
    await setVisibility('hidden')
    expect(openPages()).toHaveLength(0)
    // the server removed it and answered while the tab was hidden
    await act(async () => held.at(-1)?.answer())
    await settle()
    expect(rows()).toHaveLength(4)
    await setVisibility('visible')
    // the page reads again, refreshing, and the removed row stays away
    expect(openPages()).toHaveLength(1)
    expect(rows()).toHaveLength(4)
    await until(() =>
      expect(
        container.querySelector('[data-inbox-page-state]')?.getAttribute('data-inbox-page-state'),
      ).toBe('ok'),
    )
    expect(rows()).toHaveLength(4)
    expect(store.P.inboxMarks.size).toBe(0)
  })

  it('ends a mark settled while no Inbox showed once one mounts, before its first page answers', async () => {
    await openInbox(() => {
      project('firmware', 'Firmware', { parent_id: 'atlas' })
      for (let n = 0; n < 5; n++) group(n, 'firmware')
    })
    await until(() => expect(rows()).toHaveLength(5))
    holding = true
    await rowMenu(key('task-a-0000'))
    await press(item('Mark as read'))
    // the Inbox goes, then the server accepts the read
    await remount()
    await act(async () => held.at(-1)?.answer())
    await settle()
    expect(store.P.inboxMarks.get(key('task-a-0000'))).toMatchObject({ read: true, settled: true })
    // an Inbox mounted afresh reads afresh, so the mark ends before its
    // first page answers
    double.live?.forceInbox('loading', 'inbox:page')
    await mountInbox()
    expect(rows()).toHaveLength(0)
    expect(store.P.inboxMarks.size).toBe(0)
  })

  it('reads nothing while a kept Inbox hides behind another view, and shows the same page again', async () => {
    await openInbox(everyday, { kept: true })
    await until(() => expect(rows()).toHaveLength(50))
    await next()
    await until(() => expect(titles()[0]).toBe('Task 50'))
    await act(async () => showKept(false))
    await settle()
    expect(openPages()).toHaveLength(0)
    await act(async () => showKept(true))
    await settle()
    await until(() => expect(openPages()).toHaveLength(1))
    expect(titles()[0]).toBe('Task 50')
    expect(lastAsk()).toHaveProperty('after')
  })

  it('keeps at most PAGE_LIMITS.starts starts, so Previous stops at the oldest one held', async () => {
    await openInbox(
      () => {
        project('firmware', 'Firmware', { parent_id: 'atlas' })
        for (let n = 0; n < 300; n++) group(n, 'firmware')
      },
      { tasks: false },
    )
    // the module the Inbox loaded
    const { PAGE_LIMITS } = await import('../lib/pagedList')
    PAGE_LIMITS.starts = 3
    await until(() => expect(rows()).toHaveLength(50))
    for (let n = 0; n < 5; n++) await next()
    await until(() => expect(titles()[0]).toBe('Task 250'))
    let back = 0
    while (button('[data-inbox-page-previous]')) {
      await previous()
      back++
    }
    expect(back).toBe(2)
    await until(() => expect(titles()[0]).toBe('Task 150'))
  })

  it('on a phone, sends its segments as arguments, has no search, and ends the list with its fold', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(max-width: 760px)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
    await openInbox(everyday, { tasks: false })
    await until(() => expect(rows()).toHaveLength(50))
    expect(container.querySelector('[data-inbox-search]')).toBeNull()
    const list = container.querySelector('.inbox-list-scroll')
    expect(list?.lastElementChild?.querySelector('[data-inbox-page-end]')).not.toBeNull()
    await press(item('Unread'))
    await until(() => expect(lastAsk()).toMatchObject({ unread_only: true, kinds: [] }))
    await press(item('Mentions'))
    await until(() => expect(lastAsk()).toMatchObject({ unread_only: false, kinds: ['mention'] }))
    await press(item('All'))
    await until(() => expect(lastAsk()).toMatchObject({ unread_only: false, kinds: [] }))
    expect(pageWatches.some((w) => 'search' in w.args)).toBe(false)
  })
})
