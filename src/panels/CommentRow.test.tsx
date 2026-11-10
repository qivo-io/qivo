// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot, underProgram } from '../store/plannerFixture.setup'
import type { Row } from '../store/rows'

/* The task window's comment rows (IssueDetail.tsx CommentRow), memoized,
   on the real store: a row renders again only when its own comment or
   another prop it reads changes. Each row's body goes through Markdown,
   which this file counts by text, so a body's count is its row's renders.
   The comments arrive through the threadComments subscription, answered by
   hand. Only Date is faked, at NOW unless a case moves it, so a row's age
   changes only where a case says so while the store's and React's timers
   run as they do. */

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
/* How often Markdown rendered each text, which a comment row renders its
   body with on every render of its own. */
const renders = vi.hoisted(() => new Map<string, number>())
vi.mock('../components/markdown', async (importOriginal) => {
  const real = await importOriginal<typeof import('../components/markdown')>()
  const { createElement } = await import('react')
  return {
    Markdown: (props: Parameters<typeof real.Markdown>[0]) => {
      renders.set(props.text, (renders.get(props.text) ?? 0) + 1)
      return createElement(real.Markdown, props)
    },
  }
})

type Page = { comments: Row<'comments'>[]; earlier: boolean }
type Planner = typeof import('../store/planner')['P']
type Detail = typeof import('./IssueDetail')

const START = Date.parse('2026-09-14T08:00:00.000Z')
const at = (minute: number) => new Date(START + minute * 60_000).toISOString()
/* The clock's time when a case opens the window, ten minutes after START. */
const NOW = START + 10 * 60_000

let P: Planner
let detail: Detail
let container: HTMLDivElement
let root: Root
let me: string
let publish: (page: Page) => void

const comment = (n: number): Row<'comments'> => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  issue_id: 'task-a',
  author: me,
  body: `Check ${n}`,
  created_at: at(n),
})
const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, n) => comment(from + n))

/* Loads the store with task-a and opens its window. */
async function open() {
  vi.resetModules()
  const snap: Snapshot = underProgram(plannerFixture())
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
  network.onUpdate.mockImplementation((ref, _args, next) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (name === 'snapshot:threadComments') publish = next
    return () => {}
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  const store = await import('../store/planner')
  P = store.P
  await store.initStore()
  detail = await import('./IssueDetail')
  const task = P.openTask('task-a', P.homeOrg, null)
  await act(async () =>
    root.render(
      <TooltipProvider>
        <detail.IssueDetail issueId={task} onClose={vi.fn()} onOpen={vi.fn()} />
      </TooltipProvider>,
    ),
  )
}

async function deliver(page: Page) {
  await act(async () => publish(page))
}

/* The comment bodies the thread shows, top to bottom. */
const bodies = () =>
  [...document.querySelectorAll('[data-spine] [data-comment]')].map(
    (row) => row.querySelector('.md, p')?.textContent ?? row.textContent ?? '',
  )

/* The text of comment `n`'s row: its author, its age and its body. */
const rowText = (n: number) =>
  document.querySelector(`[data-comment="${comment(n).id}"]`)?.textContent ?? ''

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  // jsdom lays nothing out, and the window scrolls rows into view
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  window.showToast = vi.fn()
  renders.clear()
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
  vi.useRealTimers()
})

describe('the comment rows of the task window', { timeout: 30_000 }, () => {
  it('draws a delivered comment and leaves the rows that did not change alone', async () => {
    await open()
    await deliver({ comments: range(1, 6), earlier: false })
    expect(bodies()).toEqual(['Check 1', 'Check 2', 'Check 3', 'Check 4', 'Check 5'])
    const before = new Map(renders)
    for (let n = 1; n < 6; n++) expect(before.get(`Check ${n}`), `#${n}`).toBeGreaterThan(0)
    await deliver({ comments: range(1, 7), earlier: false })
    expect(bodies()).toEqual(['Check 1', 'Check 2', 'Check 3', 'Check 4', 'Check 5', 'Check 6'])
    expect(renders.get('Check 6')).toBeGreaterThan(0)
    for (let n = 1; n < 6; n++)
      expect(renders.get(`Check ${n}`), `#${n}`).toBe(before.get(`Check ${n}`))
  })

  it('draws an edited comment again, and only that one', async () => {
    await open()
    await deliver({ comments: range(1, 6), earlier: false })
    const before = new Map(renders)
    const edited = range(1, 6).map((row) =>
      row.body === 'Check 3'
        ? { ...row, body: 'Check 3 against the spare sensors', edited_at: at(30), edited_by: me }
        : row,
    )
    await deliver({ comments: edited, earlier: false })
    expect(bodies()).toEqual([
      'Check 1',
      'Check 2',
      'Check 3 against the spare sensors',
      'Check 4',
      'Check 5',
    ])
    expect(renders.get('Check 3 against the spare sensors')).toBeGreaterThan(0)
    for (const n of [1, 2, 4, 5])
      expect(renders.get(`Check ${n}`), `#${n}`).toBe(before.get(`Check ${n}`))
  })

  it('draws every row again with its new age in a render a minute later', async () => {
    await open()
    await deliver({ comments: range(1, 6), earlier: false })
    for (let n = 1; n < 6; n++) expect(rowText(n), `#${n}`).toContain(`${10 - n}m ago`)
    const before = new Map(renders)
    vi.setSystemTime(NOW + 60_000)
    await deliver({ comments: range(1, 7), earlier: false })
    expect(renders.get('Check 6')).toBeGreaterThan(0)
    for (let n = 1; n < 6; n++) {
      expect(renders.get(`Check ${n}`), `#${n}`).toBe((before.get(`Check ${n}`) ?? 0) + 1)
      expect(rowText(n), `#${n}`).toContain(`${11 - n}m ago`)
    }
  })
})
