// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'
import type { Row } from '../store/rows'

/* "Show earlier comments" in the task window, on the real store. The thread
   arrives through the commentThread subscription and earlier pages through
   commentsBefore and historyBefore, all answered by hand. Comment #n is
   posted n minutes after START. The thread's deliveries also carry the task's
   newest changes, and change(n) moves the task n minutes after START. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

type Page = { comments: Row<'comments'>[]; earlier: boolean }
// A commentThread delivery. Unlike a commentsBefore page, it carries the task's changes.
type Delivery = Page & { events: Row<'activity_events'>[]; events_earlier: boolean }
// A historyBefore page.
type History = { events: Row<'activity_events'>[]; earlier: boolean }
type Planner = typeof import('../store/planner')['P']
type Detail = typeof import('./IssueDetail')

const START = Date.parse('2026-09-14T08:00:00.000Z')
const at = (minute: number) => new Date(START + minute * 60_000).toISOString()

let P: Planner
let detail: Detail
let container: HTMLDivElement
let root: Root
let me: string
let org: string
let publish: (page: Delivery) => void
let pages: { before: string; resolve: (page: Page) => void; reject: (e: unknown) => void }[]
let histories: { before: string; resolve: (page: History) => void }[]

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
  org_id: org,
  ts: at(n),
  actor_id: me,
  verb: 'moved',
  target_type: 'issue',
  target_id: 'task-a',
  label: 'QN-27',
  detail: 'To Do → In Progress',
})

/* Loads the store with task-a. `unread` is the minute of an unread comment
   message about it. */
async function load({ unread }: { unread?: number } = {}) {
  vi.resetModules()
  const snap: Snapshot = plannerFixture()
  me = snap.profiles[0].id
  org = snap.orgs[0].id
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
  if (unread !== undefined) {
    snap.messages.push({
      id: 'message-a',
      org_id: snap.orgs[0].id,
      recipient_id: me,
      issue_id: 'task-a',
      issue_title: 'Run the soak test',
      kind: 'comment',
      detail: 'New comment',
      created_at: at(unread),
    })
  }
  pages = []
  histories = []
  network.onUpdate.mockImplementation((ref, _args, next) => {
    const name = getFunctionName(ref)
    if (name === 'snapshot:forMe') next(structuredClone(snap))
    else if (name === 'snapshot:commentThread') publish = next
    return () => {}
  })
  network.query.mockImplementation(
    (ref, args: { before?: string }) =>
      new Promise((resolve, reject) => {
        const name = getFunctionName(ref)
        if (name === 'snapshot:historyBefore')
          return histories.push({ before: args.before ?? '', resolve })
        if (name !== 'snapshot:commentsBefore') return resolve(null)
        pages.push({ before: args.before ?? '', resolve, reject })
      }),
  )
  // writes succeed, since opening the task marks its messages read
  network.mutation.mockResolvedValue(null)
  const store = await import('../store/planner')
  P = store.P
  await store.initStore()
  detail = await import('./IssueDetail')
}

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
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function open() {
  const task = P.issues.find((it) => it.uuid === 'task-a')
  if (!task) throw new Error('missing the task')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <detail.IssueDetail issueId={task.id} onClose={vi.fn()} onOpen={vi.fn()} />
      </TooltipProvider>,
    ),
  )
}

/* The thread as rendered, top to bottom: the control above it, comments by
   their text, the status change as `event` and the New line as `New`. */
function thread(): string[] {
  const feed = document.querySelector('[data-spine]')
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
/* Switches the thread to the All filter, which shows changes beside the
   comments. */
async function showAll() {
  const all = [...document.querySelectorAll('button')].find((b) => b.textContent === 'All')
  if (!all) throw new Error('missing the All filter')
  await act(async () => all.click())
}
const tailNote = () => document.querySelector('[data-unread-divider="tail"]')?.textContent
const control = () => document.querySelector<HTMLElement>('[data-earlier-comments]')
/* Focuses the control, once the window has taken its own first focus, as it
   does right after it opens. */
async function focusControl() {
  await vi.waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('dialog'))
  control()?.querySelector('button')?.focus()
}

/* Delivers the thread's live window, with no changes unless the page
   names some, and the whole history unless it says there is more. */
async function deliver(
  page: Page & { events?: Row<'activity_events'>[]; events_earlier?: boolean },
) {
  await act(async () => publish({ events: [], events_earlier: false, ...page }))
}
async function press(name: string) {
  const button = [...document.querySelectorAll('[data-earlier-comments] button')].find(
    (b) => b.textContent === name,
  )
  if (!(button instanceof HTMLElement)) throw new Error(`missing ${name}`)
  await act(async () => button.click())
}
async function answer(page: Page) {
  await act(async () => pages[pages.length - 1].resolve(page))
}

// Each test imports the whole task window afresh, which takes seconds on a
// busy CI worker.
describe('earlier comments in the task window', { timeout: 20_000 }, () => {
  it('shows the button above the oldest loaded comment and loads the page above it', async () => {
    await load()
    await open()
    await deliver({ comments: range(60, 110), earlier: true })
    const rows = thread()
    expect(rows[0]).toBe('[Show earlier comments]')
    expect(rows[1]).toContain('Check 60')
    await press('Show earlier comments')
    expect(pages.map((p) => p.before)).toEqual([comment(60).id])
    expect(control()?.dataset.earlierComments).toBe('loading')
    expect(thread()[0]).toBe('[Loading earlier comments…]')
    await answer({ comments: range(10, 60), earlier: true })
    expect(thread()[0]).toBe('[Show earlier comments]')
    expect(thread()[1]).toContain('Check 10')
    expect(thread()).toHaveLength(101)
    await press('Show earlier comments')
    expect(pages[1].before).toBe(comment(10).id)
    await answer({ comments: range(1, 10), earlier: false })
    expect(control()).toBeNull()
    expect(thread()[0]).toContain('Check 1')
  })

  it('offers Retry after a failed load and keeps the loaded thread', async () => {
    await load()
    await open()
    await deliver({ comments: range(60, 110), earlier: true })
    await press('Show earlier comments')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => pages[0].reject(new Error('offline')))
    expect(thread()[0]).toBe("[Couldn't load earlier comments.Retry]")
    expect(thread()).toHaveLength(51)
    await press('Retry')
    expect(pages.map((p) => p.before)).toEqual([comment(60).id, comment(60).id])
    await answer({ comments: range(1, 60), earlier: false })
    expect(control()).toBeNull()
    expect(thread()).toHaveLength(109)
  })

  it('moves keyboard focus to the control that replaces the one pressed', async () => {
    await load()
    await open()
    await deliver({ comments: range(60, 110), earlier: true })
    await focusControl()
    await press('Show earlier comments')
    await answer({ comments: range(10, 60), earlier: true })
    expect(document.activeElement?.textContent).toBe('Show earlier comments')
  })

  it('leaves focus where the reader moved it while the page loaded', async () => {
    await load()
    await open()
    await deliver({ comments: range(60, 110), earlier: true })
    await focusControl()
    await press('Show earlier comments')
    const all = [...document.querySelectorAll('button')].find((b) => b.textContent === 'All')
    if (!all) throw new Error('missing the All filter')
    all.focus()
    await answer({ comments: range(10, 60), earlier: true })
    expect(document.activeElement).toBe(all)
  })

  it('moves keyboard focus to the first comment once the start of the thread is loaded', async () => {
    await load()
    await open()
    await deliver({ comments: range(60, 110), earlier: true })
    await focusControl()
    await press('Show earlier comments')
    await answer({ comments: range(1, 60), earlier: false })
    expect(control()).toBeNull()
    const first = document.querySelector<HTMLElement>(`[data-comment="${comment(1).id}"]`)
    expect(document.activeElement).toBe(first)
    // focusable only until focus moves on, so a click on it later does not focus it
    first?.blur()
    expect(first?.hasAttribute('tabindex')).toBe(false)
  })

  it('keeps the oldest loaded comment where it was on screen, also after a scroll while loading', async () => {
    await load()
    await open()
    await deliver({ comments: range(60, 110), earlier: true })
    // jsdom has no layout. Each row of the thread is 100 px tall, and the
    // spine's scroller is the ancestor that scrolls.
    const scroller = document.querySelector<HTMLElement>('[data-spine-scroll]')
    if (!scroller) throw new Error('missing the scroller')
    let scrollTop = 0
    Object.defineProperties(scroller, {
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value
        },
      },
      scrollHeight: { configurable: true, get: () => 20_000 },
      clientHeight: { configurable: true, get: () => 600 },
    })
    const computed = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) =>
      el === scroller ? ({ overflowY: 'auto' } as CSSStyleDeclaration) : computed(el, pseudo),
    )
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const index = this.parentElement ? [...this.parentElement.children].indexOf(this) : 0
      return new DOMRect(0, index * 100 - scrollTop, 600, 100)
    })
    const onScreen = () =>
      document.querySelector(`[data-comment="${comment(60).id}"]`)?.getBoundingClientRect().top
    expect(onScreen()).toBe(100)
    await press('Show earlier comments')
    // the reader scrolls a little while the page loads
    scrollTop = 30
    await answer({ comments: range(10, 60), earlier: true })
    expect(onScreen()).toBe(70)
    expect(scrollTop).toBe(30 + 50 * 100)
  })

  it('shows no button when the whole thread is loaded', async () => {
    await load()
    await open()
    await deliver({ comments: range(1, 30), earlier: false })
    expect(control()).toBeNull()
  })

  it('with All, hides changes older than the oldest loaded comment until the start is loaded', async () => {
    await load()
    await open()
    await deliver({ comments: range(20, 70), earlier: true, events: [change(10)] })
    await showAll()
    expect(thread()).not.toContain('event')
    await press('Show earlier activity')
    await answer({ comments: range(1, 20), earlier: false })
    const rows = thread()
    expect(rows.indexOf('event')).toBe(rows.findIndex((r) => r.includes('Check 10')) + 1)
  })

  it('with All, hides comments older than the oldest loaded change and pages the history', async () => {
    await load()
    await open()
    const newest = Array.from({ length: 10 }, (_, i) => change(30 + i))
    await deliver({ comments: range(1, 40), earlier: false, events: newest, events_earlier: true })
    // Comments shows every comment and nothing to load
    expect(thread().filter((r) => r.startsWith('Check'))).toHaveLength(39)
    expect(control()).toBeNull()
    await showAll()
    expect(thread()[0]).toBe('[Show earlier activity]')
    expect(thread()[1]).toContain('Check 30')
    await press('Show earlier activity')
    expect(histories.map((h) => h.before)).toEqual(['event-30'])
    expect(thread()[0]).toBe('[Loading earlier activity…]')
    await act(async () => histories[0].resolve({ events: [change(5), change(12)], earlier: false }))
    const rows = thread()
    expect(control()).toBeNull()
    expect(rows.filter((r) => r === 'event')).toHaveLength(12)
    expect(rows[0]).toContain('Check 1')
    expect(rows.indexOf('event')).toBe(rows.findIndex((r) => r.includes('Check 5')) + 1)
    expect(pages).toEqual([])
  })

  it('keeps a change that left the live page as newer ones arrived', async () => {
    await load()
    await open()
    await showAll()
    const page = (from: number) => Array.from({ length: 5 }, (_, i) => change(from + i))
    await deliver({ comments: range(1, 3), earlier: false, events: page(30), events_earlier: true })
    await deliver({ comments: range(1, 3), earlier: false, events: page(31), events_earlier: true })
    expect(thread().filter((r) => r === 'event')).toHaveLength(6)
    // the next page is asked before the oldest change kept
    await press('Show earlier activity')
    expect(histories.map((h) => h.before)).toEqual(['event-30'])
  })

  it('points at All for a new change the thread delivered', async () => {
    await load({ unread: 20 })
    await open()
    await deliver({ comments: range(1, 10), earlier: false, events: [change(25)] })
    expect(tailNote()).toBe('New activity on this task. See All.')
  })

  it('does not point at All when the thread holds no new change', async () => {
    await load({ unread: 20 })
    await open()
    await deliver({ comments: range(1, 10), earlier: false, events: [change(15)] })
    expect(tailNote()).toBe('New activity on this task.')
  })

  it('puts the New line under the button when the first unread comment is not loaded', async () => {
    await load({ unread: 30 })
    await open()
    await deliver({ comments: range(60, 110), earlier: true })
    expect(thread().slice(0, 3)).toEqual([
      '[Show earlier comments]',
      'New',
      expect.stringContaining('Check 60'),
    ])
    await press('Show earlier comments')
    await answer({ comments: range(10, 60), earlier: true })
    const rows = thread()
    expect(rows[rows.indexOf('New') + 1]).toContain('Check 30')
  })

  it('keeps the loaded thread while new comments arrive', async () => {
    await load()
    await open()
    await deliver({ comments: range(60, 110), earlier: true })
    await press('Show earlier comments')
    await answer({ comments: range(10, 60), earlier: true })
    await deliver({ comments: range(65, 115), earlier: true })
    const rows = thread()
    expect(rows).toHaveLength(106)
    expect(rows[1]).toContain('Check 10')
    expect(rows[rows.length - 1]).toContain('Check 114')
  })
})
