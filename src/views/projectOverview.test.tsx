// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForcedOverview } from '../store/overviewStandIn.setup'
import type { ScopeInfo } from '../store/planner'
import type { Snapshot } from '../store/plannerFixture.setup'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* A project or sub-project's Overview (views/overview/ProjectOverview.tsx)
   from the server's answers, through the Overview's stand-in
   (store/overviewStandIn.setup.ts), whose Needs attention list holds the
   stored facts' kinds: the sentence and Tasks left, a count Qivo could not
   work out, a tab's read, a row opened while the next answer loads, the
   people's load reads of a kept page, the sub-projects' Load more and cap,
   a milestone's late count, and the row actions a reader may not use. The
   list's own rule is the server's, which convex/tests/overviewNeeds.test.ts
   tests. */

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

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Element.prototype.getAnimations = () => []
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Today's date `offset` days on, YYYY-MM-DD, local time. */
const day = (offset: number) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Plan over the fixture's sub-project One, with two tasks 3 and 10 days
    overdue and a paused one, and a task with nothing wrong, all One's. */
const plan = (snap: Snapshot) => {
  const base = snap.projects[0]
  snap.projects.push({ ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 2, name: 'Plan' })
  Object.assign(base, { parent_id: 'plan', name: 'One', track_delay: true })
  snap.issues.push({ ...taskRow(snap, 'late', 'progress', 1), due_date: day(-3) })
  snap.issues.push({ ...taskRow(snap, 'later', 'todo', 2), due_date: day(-10) })
  snap.issues.push({ ...taskRow(snap, 'held', 'todo', 3), paused: true })
  snap.issues.push(taskRow(snap, 'fine', 'todo', 4))
}

async function overview(
  prepare: (snap: Snapshot) => void,
  { scope = 'plan', force = {} as ForcedOverview, kept = false } = {},
) {
  const board = await loadBoard(network, prepare, { scope })
  board.server.overview.force = force
  const { Overview } = await import('./Overview')
  const { KeptView } = await import('../components/KeptView')
  const { IssueDetail } = await import('../panels/IssueDetail')
  const actions = new Proxy({}, { get: () => () => {} }) as never
  /* the page as App shows it, in its kept view, with the task window that
     a row opens beside it */
  function Screen({ info, shown }: { info: ScopeInfo; shown: boolean }) {
    const [opened, setOpened] = useState<string | null>(null)
    const open = new Proxy(actions, {
      get: (_, name) => (name === 'openIssue' ? setOpened : () => {}),
    })
    return (
      <>
        <KeptView view="overview" shown={shown} className="view">
          <Overview info={info} actions={open} />
        </KeptView>
        <IssueDetail issueId={opened} onClose={() => setOpened(null)} onOpen={setOpened} />
      </>
    )
  }
  const show = (shown: boolean) =>
    board.renderView(root, (info: ScopeInfo) => <Screen info={info} shown={shown} />)
  if (kept) await show(true)
  else await board.renderView(root, (info: ScopeInfo) => <Overview info={info} actions={actions} />)
  return { board, show }
}

const q = (selector: string) => document.querySelector<HTMLElement>(selector)
const text = (selector: string) => q(selector)?.textContent ?? ''
const tab = (kind: string) => q(`[data-ov-tab="${kind}"]`)
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-need]')]
const needsAsked = (board: Awaited<ReturnType<typeof overview>>['board']) =>
  board.server.overview.asked.filter((a) => a.query === 'needs').map((a) => a.args)

describe("a project's Overview", { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('states the overdue tasks, then says nothing needs attention and what is left once none does', async () => {
    await overview(plan)
    expect(text('[data-ov-sentence]')).toBe('2 tasks are overdue.')
    expect(text('[data-ov-figure="tasks-left"]')).toBe('Tasks left4')
    // the most days overdue first, then the paused task
    expect(rows().map((r) => r.dataset.kind)).toEqual(['overdue', 'overdue', 'paused'])
    await act(async () => root.unmount())
    root = createRoot(container)
    await overview((snap) => {
      plan(snap)
      snap.issues = snap.issues.filter((t) => t.id === 'fine')
    })
    expect(text('[data-ov-sentence]')).toBe('Nothing needs attention. 1 task is left.')
    expect(text('[data-ov-needs]')).toBe('Nothing needs attention.')
  })

  it('reads a count it could not work out as unknown, never 0, and says the list may leave tasks out', async () => {
    await overview(plan, { force: { needs: 'unknown' } })
    for (const kind of ['all', 'projected', 'behind'])
      expect(tab(kind)?.getAttribute('aria-label'), kind).toMatch(/count unknown$/)
    expect(tab('overdue')?.getAttribute('aria-label')).toBe('Overdue, 2 tasks')
    expect(text('[data-ov-unknown]')).toContain('may leave tasks out')
    // the rows of the stored facts still show
    expect(rows()).toHaveLength(3)
  })

  it('says none on a tab only for a confirmed zero, and that Qivo found none among the tasks it could check where the count is unknown', async () => {
    const { board } = await overview(plan, { force: { needs: 'unknown' } })
    await act(async () => tab('projected')?.click())
    await board.answer()
    expect(text('[data-ov-needs]')).toBe(
      'Qivo found no task projected to miss its due date among the tasks it could check.',
    )
    await act(async () => tab('blocked')?.click())
    await board.answer()
    expect(text('[data-ov-needs]')).toBe('No task is blocked.')
  })

  it("opens a row's task while the next answer of the list is on its way", async () => {
    const { board } = await overview(plan, { kept: true })
    board.server.overview.hold = (query) => query === 'needs'
    await act(async () => tab('paused')?.click())
    // the last answer's rows stay, dimmed, while the Paused tab's loads
    const row = rows()[0]
    expect(row?.dataset.kind).toBe('overdue')
    await act(async () => row?.querySelector<HTMLElement>('[data-focus-key="row"]')?.click())
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(text('[data-task-title]')).toBe('Task later')
  })

  it("stops the people's load reads while its kept page hides, and reads them again when it shows", async () => {
    const { board, show } = await overview(plan, { kept: true })
    expect(q('[data-ov-people]')).not.toBeNull()
    expect(board.server.loads.size).toBeGreaterThan(0)
    await show(false)
    expect(board.server.loads.size).toBe(0)
    await show(true)
    expect(board.server.loads.size).toBeGreaterThan(0)
  })

  it('asks a failed Load more of the sub-projects again with Retry, and says how many it shows past the cap', async () => {
    /** Plan's sub-projects: One and eleven more. */
    const twelve = (snap: Snapshot) => {
      plan(snap)
      const base = snap.projects[0]
      for (let n = 2; n <= 12; n++)
        snap.projects.push({ ...base, id: `sub${n}`, key: `S${n}`, num: 10 + n, name: `Sub ${n}` })
    }
    const subs = () => document.querySelectorAll('[data-ov-sub]').length
    const section = () => q('[data-ov-subs]')?.closest('section') ?? null
    const button = (label: string) =>
      [...(section()?.querySelectorAll<HTMLElement>('button') ?? [])].find(
        (b) => b.textContent === label,
      )
    const { board } = await overview(twelve)
    expect(subs()).toBe(10)
    board.server.overview.fail = new Error('down')
    board.server.overview.failing = (query, args) =>
      query === 'health' && (args.limit as number) > 10
    await act(async () => q('[data-ov-subs-more]')?.click())
    await board.answer()
    expect(subs()).toBe(10)
    expect(section()?.textContent).toContain("Couldn't load more sub-projects.")
    board.server.overview.fail = undefined
    await act(async () => button('Retry')?.click())
    await board.answer()
    expect(subs()).toBe(12)
    await act(async () => root.unmount())
    root = createRoot(container)
    await overview(twelve, { force: { health: { most: 10 } } })
    expect(subs()).toBe(10)
    expect(q('[data-ov-subs-more]')).toBeNull()
    expect(section()?.textContent).toContain('Qivo shows the first 10 of 12 sub-projects.')
  })

  it("counts a milestone's late tasks up to the first day of its week in the project's organization, whatever week the reader's calendar starts on", async () => {
    /** A Monday at least two weeks on, YYYY-MM-DD, local time. */
    const monday = (() => {
      const d = new Date()
      d.setDate(d.getDate() + 21)
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })()
    const { board } = await overview((snap) => {
      // the reader's own organization starts its weeks on Sunday; Plan is
      // a partner's, whose weeks start on Monday, and the reader its guest
      snap.orgs[0].week_start = 0
      const org = crypto.randomUUID()
      const seat = crypto.randomUUID()
      snap.orgs.push({
        ...snap.orgs[0],
        id: org,
        name: 'Partner Co',
        slug: 'partner',
        week_start: 1,
      })
      snap.profiles.push({ ...snap.profiles[0], id: seat, org_id: org, org_role: 'guest' })
      snap.myProfileIds.push(seat)
      plan(snap)
      for (const p of snap.projects) Object.assign(p, { org_id: org, lead_id: seat })
      for (const t of snap.issues) Object.assign(t, { org_id: org, assignee_id: seat })
      snap.access.push({ project_id: 'plan', profile_id: seat, level: 'user' })
      snap.milestones.push({
        id: 'launch',
        project_id: 'plan',
        name: 'Launch',
        week: monday,
        created_at: '2026-09-14T08:00:00.000Z',
      })
    })
    // one task projected to miss, due on the milestone's Monday
    board.server.overview.edit = (query, answer) => {
      const a = answer as { state: string }
      return query === 'needs' && a.state === 'ok'
        ? { ...a, tracks_delay: true, late_due: { state: 'ok', days: [{ due: monday, count: 1 }] } }
        : answer
    }
    await board.answer()
    expect(text('[data-overview-milestone="launch"]')).toContain('1 late task is due before it')
  })

  it("asks the server for a tab's kind and shows its rows", async () => {
    const { board } = await overview(plan)
    expect(needsAsked(board).at(-1)).toMatchObject({ kind: 'all', limit: 20 })
    await act(async () => tab('paused')?.click())
    await board.answer()
    expect(needsAsked(board).at(-1)).toMatchObject({ kind: 'paused', limit: 20 })
    expect(tab('paused')?.getAttribute('aria-selected')).toBe('true')
    expect(rows().map((r) => r.dataset.kind)).toEqual(['paused'])
  })

  it('offers Reassign and Move due date on a row only to a reader who may edit its task', async () => {
    await overview(plan)
    expect(rows()[0]?.querySelector('[aria-label^="Reassign"]')).not.toBeNull()
    expect(rows()[0]?.querySelector('[aria-label^="Move due date"]')).not.toBeNull()
    await act(async () => root.unmount())
    root = createRoot(container)
    await overview((snap) => {
      plan(snap)
      snap.profiles[0].org_role = 'viewer'
      snap.access.push({ project_id: 'plan', profile_id: snap.profiles[0].id, level: 'viewer' })
    })
    expect(rows()).toHaveLength(3)
    expect(document.querySelector('[data-need] [aria-label^="Reassign"]')).toBeNull()
    expect(document.querySelector('[data-need] [aria-label^="Move due date"]')).toBeNull()
  })
})
