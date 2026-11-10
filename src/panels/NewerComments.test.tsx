// @vitest-environment jsdom
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot, underProgram } from '../store/plannerFixture.setup'
import type { Row } from '../store/rows'

/* "Show newer comments" in the task window, on the real store, with the
   store's budget (lib/threadBudget.ts THREAD_KEEP) lowered to 120 rows. The
   comments arrive through the threadComments subscription, the task's
   changes under All through threadHistory, and pages through
   commentsBefore and historyBefore, all answered by hand. Comment #n is
   posted n minutes after START, and change(n) moves the task n minutes and
   a second after START. */

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

type Page = { comments: Row<'comments'>[]; earlier: boolean }
type History = { events: Row<'activity_events'>[]; earlier: boolean; next: string | null }
type Planner = typeof import('../store/planner')['P']
type Detail = typeof import('./IssueDetail')

const START = Date.parse('2026-09-14T08:00:00.000Z')
const at = (minute: number, second = 0) =>
  new Date(START + minute * 60_000 + second * 1000).toISOString()

let P: Planner
let budget: typeof import('../lib/threadBudget')
// the figure the module holds, which load() lowers and afterEach gives back
let figure: number | undefined
let detail: Detail
let container: HTMLDivElement
let root: Root
let me: string
let org: string
let publish: (page: Page) => void
let publishHistory: ((page: History) => void) | null
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
  ts: at(n, 1),
  actor_id: me,
  verb: 'moved',
  target_type: 'issue',
  target_id: 'task-a',
  label: 'QN-27',
  detail: 'To Do → In Progress',
})

/* Loads the store with task-a and the budget lowered. `unread` is the
   minute of an unread comment message about it. */
async function load({ unread }: { unread?: number } = {}) {
  vi.resetModules()
  // the project under a top-level project, as every writer stores one
  // that holds tasks, so the project cache answers it
  const snap: Snapshot = underProgram(plannerFixture())
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
  if (unread !== undefined)
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
  pages = []
  histories = []
  publishHistory = null
  network.onUpdate.mockImplementation((ref, _args, next) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (name === 'snapshot:threadComments') publish = next
    else if (name === 'snapshot:threadHistory') {
      publishHistory = next
      return () => {
        if (publishHistory === next) publishHistory = null
      }
    }
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
  network.mutation.mockResolvedValue(null)
  const store = await import('../store/planner')
  P = store.P
  budget = await import('../lib/threadBudget')
  figure = budget.THREAD_KEEP.rows
  budget.THREAD_KEEP.rows = 120
  await store.initStore()
  detail = await import('./IssueDetail')
}

beforeEach(() => {
  // jsdom lays nothing out. ProseMirror measures a Range to scroll the caret
  // into view when edit-in-place opens with it at the end.
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
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
  if (budget && figure !== undefined) budget.THREAD_KEEP.rows = figure
  figure = undefined
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/* Renders the task window, or renders it again, `above` with a block above
   it that pushes it down the screen. */
async function open({ above = false } = {}) {
  const task = { id: P.openTask('task-a', P.homeOrg, null), uuid: 'task-a' }
  if (!task) throw new Error('missing the task')
  await act(async () =>
    root.render(
      <TooltipProvider>
        {above && <div data-above />}
        <detail.IssueDetail issueId={task.id} onClose={vi.fn()} onOpen={vi.fn()} />
      </TooltipProvider>,
    ),
  )
}

/* The thread as rendered, top to bottom: the controls in brackets,
   comments by their number as `#n`, changes as `event` and the New line
   as `New`. */
function thread(): string[] {
  const feed = document.querySelector('[data-spine]')
  if (!feed) throw new Error('missing the thread')
  return [...feed.children].map((row) => {
    const html = row as HTMLElement
    if (html.dataset.earlierComments || html.dataset.newerComments) return `[${html.textContent}]`
    if (html.dataset.unreadDivider) return 'New'
    if (html.dataset.event) return 'event'
    if (html.dataset.comment) {
      const text = html.querySelector('.md, p')?.textContent ?? html.textContent ?? ''
      return text.replace('Check ', '#')
    }
    return html.textContent ?? ''
  })
}
const comments = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, n) => `#${from + n}`)
const newerRow = () => document.querySelector<HTMLElement>('[data-newer-comments]')
async function showAll() {
  const all = [...document.querySelectorAll('button')].find((b) => b.textContent === 'All')
  if (!all) throw new Error('missing the All filter')
  await act(async () => all.click())
}
async function deliver(page: Page) {
  await act(async () => publish(page))
}
async function deliverHistory(page: History) {
  const send = publishHistory
  if (!send) throw new Error('the history is not subscribed')
  await act(async () => send(page))
}
async function press(name: string) {
  const button = [
    ...document.querySelectorAll('[data-earlier-comments] button, [data-newer-comments] button'),
  ].find((b) => b.textContent === name)
  if (!(button instanceof HTMLElement)) throw new Error(`missing ${name}`)
  await act(async () => button.click())
}
async function answer(page: Page) {
  await act(async () => pages[pages.length - 1].resolve(page))
}
/* Opens the task at its newest 50 comments, #250 to #299, and walks back
   with Show earlier comments `presses` times, 50 a page. */
async function walkBack(presses: number) {
  await open()
  await deliver({ comments: range(250, 300), earlier: true })
  for (let i = 0; i < presses; i++) {
    await press('Show earlier comments')
    await answer({ comments: range(200 - 50 * i, 250 - 50 * i), earlier: true })
  }
}
/* Puts in a stand-in IntersectionObserver and answers `see`, which tells
   the last one made that the rows it watches for which `visible` holds are
   on screen and the rest are not. */
function watchRows() {
  const observers: { callback: IntersectionObserverCallback; targets: Element[] }[] = []
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      targets: Element[] = []
      constructor(callback: IntersectionObserverCallback) {
        observers.push({ callback, targets: this.targets })
      }
      observe(target: Element) {
        this.targets.push(target)
      }
      disconnect() {}
    },
  )
  return async (visible: (el: Element) => boolean) => {
    const watcher = observers.at(-1)
    if (!watcher) throw new Error('nothing observes the rows')
    await act(async () =>
      watcher.callback(
        watcher.targets.map(
          (target) => ({ target, isIntersecting: visible(target) }) as IntersectionObserverEntry,
        ),
        {} as IntersectionObserver,
      ),
    )
  }
}
/* jsdom has no layout: lays the spine's scroller out `offset()` px down the
   screen with each row of the thread 100 px tall inside it, at scrollTop
   9000, and answers the scroller's scrollTop. */
function layOut(offset: () => number) {
  const scroller = document.querySelector<HTMLElement>('[data-spine-scroll]')
  if (!scroller) throw new Error('missing the scroller')
  let scrollTop = 9000
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
    if (this === scroller) return new DOMRect(0, offset(), 600, 600)
    const index = this.parentElement ? [...this.parentElement.children].indexOf(this) : 0
    return new DOMRect(0, offset() + index * 100 - scrollTop, 600, 100)
  })
  return () => scrollTop
}
function editorOf(label: string) {
  return vi.waitFor(
    () => {
      const found = document.querySelector<TiptapEditorHTMLElement>(
        `[role="textbox"][aria-label="${label}"]`,
      )?.editor
      if (!found) throw new Error(`missing the ${label} editor`)
      return found
    },
    { timeout: 10_000 },
  )
}

describe('newer comments in the task window', { timeout: 20_000 }, () => {
  it('shows Show newer comments where the store let comments go, loading, failed with Retry, and gone once the gap closes', async () => {
    await load()
    await walkBack(3)
    // the newest rows above the live window went, and the row stands there
    expect(thread()).toEqual([
      '[Show earlier comments]',
      ...comments(100, 170),
      '[Show newer comments]',
      ...comments(250, 300),
    ])
    expect(newerRow()?.dataset.newerComments).toBe('more')
    await press('Show newer comments')
    expect(newerRow()?.textContent).toBe('Loading newer comments…')
    expect(pages.at(-1)?.before).toBe(comment(219).id)
    await act(async () => pages.at(-1)?.reject(new Error('offline')))
    expect(newerRow()?.dataset.newerComments).toBe('failed')
    expect(newerRow()?.textContent).toBe("Couldn't load newer comments.Retry")
    // the rows stay where they were
    expect(thread()).toContain('#169')
    await press('Retry')
    expect(newerRow()?.dataset.newerComments).toBe('loading')
    await answer({ comments: range(169, 219), earlier: true })
    // the page came in under #169 and the oldest rows went
    expect(thread()).toEqual([
      '[Show earlier comments]',
      ...comments(149, 219),
      '[Show newer comments]',
      ...comments(250, 300),
    ])
    await press('Show newer comments')
    expect(pages.at(-1)?.before).toBe(comment(250).id)
    await answer({ comments: range(200, 250), earlier: true })
    expect(newerRow()).toBeNull()
    expect(thread()).toEqual(['[Show earlier comments]', ...comments(180, 300)])
  })

  it('says Show newer activity under All, and hides the changes inside the comments gap until it closes', async () => {
    await load()
    await open()
    await deliver({ comments: range(250, 300), earlier: true })
    await showAll()
    // the whole history: a change every ten minutes from minute 5
    const history = Array.from({ length: 30 }, (_, i) => change(5 + 10 * i))
    await deliverHistory({ events: history, earlier: false, next: null })
    for (let i = 0; i < 2; i++) {
      await press('Show earlier activity')
      await answer({ comments: range(200 - 50 * i, 250 - 50 * i), earlier: true })
    }
    const rows = thread()
    expect(newerRow()?.textContent).toBe('Show newer activity')
    // the second page let #201 to #249 go: nothing between #200 and #250
    // shows, so the changes at 205 to 245 are held but hidden
    const gapAt = rows.indexOf('[Show newer activity]')
    expect(rows[gapAt - 1]).toBe('#200')
    expect(rows[gapAt + 1]).toBe('#250')
    const inGap = ['event-205', 'event-215', 'event-225', 'event-235', 'event-245']
    for (const id of inGap) {
      expect(P.threadEvents.map((e) => e.id)).toContain(id)
      expect(document.querySelector(`[data-event="${id}"]`)).toBeNull()
    }
    await press('Show newer activity')
    expect(pages.at(-1)?.before).toBe(comment(250).id)
    await answer({ comments: range(200, 250), earlier: true })
    expect(newerRow()).toBeNull()
    for (const id of inGap) expect(document.querySelector(`[data-event="${id}"]`)).not.toBeNull()
  })

  it('keeps the row above Show newer where it was on screen, and gives focus to the control that replaces it', async () => {
    await load()
    await walkBack(3)
    // jsdom has no layout: each row of the thread is 100 px tall, and the
    // spine's scroller is the ancestor that scrolls
    const scroller = document.querySelector<HTMLElement>('[data-spine-scroll]')
    if (!scroller) throw new Error('missing the scroller')
    // #169 sits 200 px down the screen, not at its top, so a place kept
    // from no measure at all would show
    let scrollTop = 6800
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
      document.querySelector(`[data-comment="${comment(169).id}"]`)?.getBoundingClientRect().top
    const before = onScreen()
    newerRow()?.querySelector('button')?.focus()
    await press('Show newer comments')
    await answer({ comments: range(169, 219), earlier: true })
    // #100 to #148 went above #169, and the scroller moved up by them
    expect(before).toBe(200)
    expect(onScreen()).toBe(before)
    expect(scrollTop).toBe(6800 - 49 * 100)
    expect(document.activeElement?.closest('[data-newer-comments]')).not.toBeNull()
    // once the gap closes, focus goes to the first row that came in
    await act(async () => newerRow()?.querySelector('button')?.focus())
    await press('Show newer comments')
    await answer({ comments: range(200, 250), earlier: true })
    expect(newerRow()).toBeNull()
    expect(document.activeElement?.getAttribute('data-comment')).toBe(comment(219).id)
  })

  it('keeps the comment in its editor and its draft through a release, and the composer’s draft', async () => {
    await load()
    await walkBack(1)
    const composer = await editorOf('Leave a comment')
    await act(async () => composer.commands.insertContent('Composer draft'))
    const edit = document.querySelector<HTMLButtonElement>(
      `[data-comment="${comment(230).id}"] [aria-label="Edit comment"]`,
    )
    await act(async () => edit?.click())
    const editor = await editorOf('Edit comment')
    await act(async () => editor.commands.insertContent(' rerun'))
    // the next page lets #220 to #249 go, #230 among them
    await press('Show earlier comments')
    await answer({ comments: range(150, 200), earlier: true })
    expect(newerRow()).not.toBeNull()
    const rows = thread()
    expect(rows.indexOf('[Show newer comments]')).toBeGreaterThan(rows.indexOf('#219'))
    expect(document.querySelector('[role="textbox"][aria-label="Edit comment"]')).not.toBeNull()
    expect((await editorOf('Edit comment')).getText()).toBe('Check 230 rerun')
    // a newer page and the composer's draft
    await press('Show newer comments')
    await answer({ comments: range(200, 250), earlier: true })
    expect((await editorOf('Leave a comment')).getText()).toBe('Composer draft')
    expect((await editorOf('Edit comment')).getText()).toBe('Check 230 rerun')
  })

  it('shows no comment held apart at a live change, which sits above the comments the store let go, under Comments or All', async () => {
    await load()
    await open()
    await deliver({ comments: range(50, 100), earlier: true })
    // another window shows All, so the store holds the whole history, the
    // task archived with the reason comment #90 among it at #90's instant
    await act(async () => P.showHistory({}, true))
    const before = Array.from({ length: 9 }, (_, i) => change(5 + 10 * i))
    const after = Array.from({ length: 21 }, (_, i) => change(95 + 10 * i))
    const archived = { ...change(90), id: 'event-archived', ts: comment(90).created_at }
    await deliverHistory({ events: [...before, archived, ...after], earlier: false, next: null })
    // Comments arrive while this window reads at its newest end. Once #90
    // is the oldest comment held, the release passes it and lets #91 go,
    // so the store stays at its 120, #90 held apart
    for (let n = 60; n <= 140; n += 10) await deliver({ comments: range(n, n + 50), earlier: true })
    expect(P.threadApart).toEqual([comment(90).id])
    expect(P.comments.length + P.threadEvents.length).toBe(120)
    // #91 went, so #90 stays out of sight, under Comments and under All
    expect(thread()).toEqual(['[Show earlier comments]', ...comments(102, 190)])
    await showAll()
    expect(thread()).not.toContain('#90')
    expect(thread().find((row) => row.startsWith('#'))).toBe('#102')
    expect(document.querySelector('[data-event="event-archived"]')).toBeNull()
  })

  it('puts the New line under Show newer comments when the unread part starts among released rows', async () => {
    await load({ unread: 230 })
    await walkBack(3)
    const rows = thread()
    expect(
      rows.slice(rows.indexOf('[Show newer comments]'), rows.indexOf('[Show newer comments]') + 3),
    ).toEqual(['[Show newer comments]', 'New', '#250'])
  })

  it('reports the first row on screen as the reader scrolls, and null at the newest end', async () => {
    await load()
    const see = watchRows()
    const place = vi.spyOn(P, 'threadPlace')
    // two pages back the store holds its 120, #150 to #219 above the gap
    // and the live window
    await walkBack(2)
    // the window opens at its newest end, with the composer on screen
    await see(
      (el) =>
        el.hasAttribute('data-composer') || el.getAttribute('data-comment') === comment(299).id,
    )
    expect(place.mock.calls.at(-1)?.[1]).toBeNull()
    // the reader scrolls up to #160
    await see((el) => {
      const id = el.getAttribute('data-comment')
      return id === comment(160).id || id === comment(161).id
    })
    expect(place.mock.calls.at(-1)?.[1]).toBe(comment(160).id)
    // An arrival past the budget then lets the newer side go from the gap
    // down, #250, which slid out of the live window, and not the oldest row,
    // #150, which it lets go for a reader at the newest end
    await deliver({ comments: range(251, 301), earlier: true })
    expect(thread()).toEqual([
      '[Show earlier comments]',
      ...comments(150, 220),
      '[Show newer comments]',
      ...comments(251, 301),
    ])
  })

  it('keeps the first row on screen where it was when an arrival lets rows above go, where the browser reports scroll anchoring too', async () => {
    // WebKit answers true here and still lost the place
    vi.stubGlobal('CSS', {
      supports: (property: string, value?: string) =>
        property === 'overflow-anchor' && value === 'auto',
    })
    await load()
    const see = watchRows()
    await walkBack(2)
    const scrollTop = layOut(() => 0)
    // the reader reads #280 and #281 among the live rows
    const reading = new Set([comment(280).id, comment(281).id])
    await see((el) => reading.has(el.getAttribute('data-comment') ?? ''))
    const onScreen = () =>
      document.querySelector(`[data-comment="${comment(280).id}"]`)?.getBoundingClientRect().top
    const before = onScreen()
    const above = thread().indexOf('#280')
    // #300 arrives past the budget and a row above #280 goes
    await deliver({ comments: range(251, 301), earlier: true })
    expect(thread().indexOf('#280')).toBe(above - 1)
    expect(onScreen()).toBe(before)
    expect(scrollTop()).toBe(9000 - 100)
  })

  it('leaves the thread where it is when the window moves on screen and no row above goes', async () => {
    await load()
    const see = watchRows()
    await walkBack(2)
    // the block above, as the Inbox pane's opened description, pushes the
    // scroller and its rows 211 px down together
    const scrollTop = layOut(() => (document.querySelector('[data-above]') ? 211 : 0))
    const reading = new Set([comment(280).id, comment(281).id])
    await see((el) => reading.has(el.getAttribute('data-comment') ?? ''))
    const rows = thread()
    await open({ above: true })
    expect(thread()).toEqual(rows)
    expect(scrollTop()).toBe(9000)
  })

  it('on a phone takes the place from the feed, while the composer below it always shows', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('max-width'),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
    await load()
    const see = watchRows()
    const place = vi.spyOn(P, 'threadPlace')
    await walkBack(2)
    expect(document.querySelector('[data-mobile-task]')).not.toBeNull()
    // the feed scrolls on its own above the composer, which stays on
    // screen while the reader reads #160 and #161
    const reading = new Set([comment(160).id, comment(161).id])
    await see(
      (el) =>
        el.hasAttribute('data-composer') || reading.has(el.getAttribute('data-comment') ?? ''),
    )
    expect(place.mock.calls.at(-1)?.[1]).toBe(comment(160).id)
    // at the feed's newest end it reports null
    await see(
      (el) =>
        el.hasAttribute('data-composer') || el.getAttribute('data-comment') === comment(299).id,
    )
    expect(place.mock.calls.at(-1)?.[1]).toBeNull()
  })

  it('watches the rows All puts in the middle of the thread while its first and last rows stay', async () => {
    await load()
    const see = watchRows()
    const place = vi.spyOn(P, 'threadPlace')
    // the store holds #200 to #299, under its 120
    await walkBack(1)
    // the reader edits #200, which shows whatever All's start hides
    const edit = document.querySelector<HTMLButtonElement>(
      `[data-comment="${comment(200).id}"] [aria-label="Edit comment"]`,
    )
    await act(async () => edit?.click())
    await editorOf('Edit comment')
    // another window holds the history, its newest page from minute 209 on
    await act(async () => P.showHistory({}, true))
    const history = Array.from({ length: 9 }, (_, i) => change(209 + 10 * i))
    await deliverHistory({ events: history, earlier: true, next: history[0].id })
    const before = thread()
    await showAll()
    // All starts at the oldest change, so #201 to #209 go and the nine
    // changes come in, with the first row, the last row and the count kept
    const after = thread()
    expect(after.filter((row) => row === 'event')).toHaveLength(9)
    expect(after).not.toContain('#205')
    expect([before[1], before.at(-1), before.length]).toEqual(['#200', '#299', 101])
    expect([after[1], after.at(-1), after.length]).toEqual(['#200', '#299', 101])
    // the reader sees the change at minute 219 and #220 under it
    await see(
      (el) =>
        el.getAttribute('data-event') === 'event-219' ||
        el.getAttribute('data-comment') === comment(220).id,
    )
    expect(place.mock.calls.at(-1)?.[1]).toBe('event-219')
  })
})
