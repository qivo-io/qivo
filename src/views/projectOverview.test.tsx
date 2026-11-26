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
   (store/overviewStandIn.setup.ts), whose Needs attention list follows the
   server's rule: the sentence and Tasks left, a count Qivo could not
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

/** Plan with a fifth task, due in three weeks with 8 hours left, whose
    verdict needs its owner's load. */
const planned = (snap: Snapshot) => {
  plan(snap)
  snap.issues.push({
    ...taskRow(snap, 'planned', 'todo', 5),
    due_date: day(21),
    remaining_hours: 8,
  })
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
    await overview(planned, { force: { needs: 'unknown' } })
    for (const kind of ['all', 'projected', 'behind'])
      expect(tab(kind)?.getAttribute('aria-label'), kind).toMatch(/count unknown$/)
    expect(tab('overdue')?.getAttribute('aria-label')).toBe('Overdue, 2 tasks')
    expect(text('[data-ov-unknown]')).toContain('may leave tasks out')
    // the rows of the stored facts still show
    expect(rows()).toHaveLength(3)
  })

  it('says none on a tab only for a confirmed zero, and that Qivo found none among the tasks it could check where the count is unknown', async () => {
    const { board } = await overview(planned, { force: { needs: 'unknown' } })
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

  it("stops the people's load reads while its kept page hides, reads them again when it shows, and stops them once the page gives way to a note", async () => {
    const { board, show } = await overview(plan, { kept: true })
    expect(q('[data-ov-people]')).not.toBeNull()
    expect(board.server.loads.size).toBeGreaterThan(0)
    await show(false)
    expect(board.server.loads.size).toBe(0)
    await show(true)
    expect(board.server.loads.size).toBeGreaterThan(0)
    board.server.overview.force = { scope: 'unavailable' }
    await board.deliver()
    expect(text('[data-overview-root]')).toContain('This Overview is not available')
    expect(board.server.loads.size).toBe(0)
  })

  it("keeps the people's load reads open when a task leaves Needs attention while its owner still has open work", async () => {
    const { board } = await overview(plan)
    const person = () => text('[data-ov-person]')
    expect(person()).toContain('3 of the listed tasks')
    const before = [...board.server.loads]
    expect(before.length).toBeGreaterThan(0)
    const task = board.snapshot.issues.find((t) => t.id === 'later')
    if (task) task.due_date = day(30)
    await board.deliver()
    expect(person()).toContain('2 of the listed tasks')
    expect([...board.server.loads]).toHaveLength(before.length)
    for (const call of before) expect(board.server.loads.has(call)).toBe(true)
  })

  it("shows the sub-projects of Needs attention's answer 10 at a time, asking the server nothing more, and says how many it shows past the cap", async () => {
    /** Plan's sub-projects: One and eleven more. */
    const twelve = (snap: Snapshot) => {
      plan(snap)
      const base = snap.projects[0]
      for (let n = 2; n <= 12; n++)
        snap.projects.push({ ...base, id: `sub${n}`, key: `S${n}`, num: 10 + n, name: `Sub ${n}` })
    }
    const subs = () => document.querySelectorAll('[data-ov-sub]').length
    const section = () => q('[data-ov-subs]')?.closest('section') ?? null
    const { board } = await overview(twelve)
    const queries = () => board.server.overview.asked.map((a) => a.query)
    expect(subs()).toBe(10)
    expect(queries()).toContain('needs')
    const asked = queries().length
    await act(async () => q('[data-ov-subs-more]')?.click())
    expect(subs()).toBe(12)
    expect(q('[data-ov-subs-more]')).toBeNull()
    // no health table, and no read for Load more
    expect(queries().length).toBe(asked)
    expect(queries()).not.toContain('health')
    await act(async () => root.unmount())
    root = createRoot(container)
    await overview(twelve, { force: { health: { most: 10 } } })
    expect(subs()).toBe(10)
    expect(q('[data-ov-subs-more]')).toBeNull()
    expect(section()?.textContent).toContain('Qivo shows the first 10 of 12 sub-projects.')
  })

  it("names a sub-project's lead before the workspace holds the sub-project, loading and then by name, never as no lead", async () => {
    const { board } = await overview((snap) => {
      plan(snap)
      snap.profiles.push({
        ...snap.profiles[0],
        id: 'pat',
        auth_user_id: 'account-pat',
        name: 'Pat Lead',
        initials: 'PL',
        org_role: 'user',
      })
    })
    board.server.people.hold = true
    // the row of a sub-project whose own details have not reached the
    // workspace, led by Pat
    board.server.overview.edit = (query, answer) => {
      const ok = answer as {
        state: string
        health?: { rows: { project_id: string; lead_id: string }[] }
      }
      const first = ok.health?.rows[0]
      if (query !== 'needs' || ok.state !== 'ok' || !ok.health || !first) return answer
      return {
        ...ok,
        health: {
          ...ok.health,
          rows: [...ok.health.rows, { ...first, project_id: 'unplaced', lead_id: 'pat' }],
        },
      }
    }
    await board.deliver()
    const row = () => q('[data-ov-sub="unplaced"]')?.getAttribute('aria-label') ?? ''
    expect(row()).toMatch(/^One, Loading…, Lead, /)
    board.server.people.hold = false
    await board.answerPeople()
    await act(async () => vi.waitFor(() => expect(row()).toMatch(/^One, Pat Lead, Lead, /)))
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

describe('keyboard focus on a project Overview', { timeout: BOARD_TEST_TIMEOUT }, () => {
  /** Presses `key` on what has focus, as a keyboard does. */
  const key = (key: string) =>
    act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      )
    })

  it("gives Move due date's calendar focus on the due date, moves it by arrow keys, and gives it back to the action", async () => {
    await overview(plan)
    const action = rows()[0]?.querySelector<HTMLElement>('[aria-label^="Move due date"]')
    await act(async () => {
      action?.focus()
      action?.click()
    })
    // the row's task is 10 days overdue
    expect(document.activeElement?.getAttribute('data-cal-day')).toBe(day(-10))
    expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull()
    await key('ArrowDown')
    expect(document.activeElement?.getAttribute('data-cal-day')).toBe(day(-3))
    // the first Escape closes the focused day's tooltip, the second the
    // calendar
    await key('Escape')
    await key('Escape')
    expect(q('[data-calendar]')).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(
      /^Move due date of Task later/,
    )
  })

  it('keeps focus on the list when Load more loads the last rows, and on the next row when a row leaves', async () => {
    const { board } = await overview((snap) => {
      plan(snap)
      for (let n = 5; n <= 26; n++)
        snap.issues.push({ ...taskRow(snap, `p${n}`, 'todo', n), paused: true })
    })
    expect(rows()).toHaveLength(20)
    const more = q('[data-ov-needs] [data-ov-more]')
    await act(async () => {
      more?.focus()
      more?.click()
    })
    expect(rows()).toHaveLength(25)
    expect(q('[data-ov-more]')).toBeNull()
    expect(document.activeElement).toBe(q('[data-ov-needs]'))
    // the first row's task is no longer overdue
    const open = (row: HTMLElement | undefined) =>
      row?.querySelector<HTMLElement>('[data-focus-key="row"]')
    const [first, second] = rows()
    await act(async () => open(first)?.focus())
    const task = board.snapshot.issues.find((t) => t.id === 'later')
    if (task) task.due_date = day(30)
    await board.deliver()
    expect(rows()[0]).toBe(second)
    expect(document.activeElement).toBe(open(second))
  })

  it('moves focus on again when the row it moved to leaves too, with no focus event in between', async () => {
    const { board } = await overview((snap) => {
      plan(snap)
      for (let n = 5; n <= 8; n++)
        snap.issues.push({ ...taskRow(snap, `p${n}`, 'todo', n), paused: true })
    })
    const open = (row: HTMLElement | undefined) =>
      row?.querySelector<HTMLElement>('[data-focus-key="row"]')
    const clear = async (row: HTMLElement | undefined) => {
      const task = board.snapshot.issues.find((t) => t.id === row?.dataset.needId)
      if (task) Object.assign(task, { paused: false, due_date: day(30) })
      await board.deliver()
    }
    const [first, second, third] = rows()
    await act(async () => open(first)?.focus())
    // a window in the background sends no focus events
    const mute = (e: Event) => e.stopImmediatePropagation()
    document.addEventListener('focusin', mute, true)
    document.addEventListener('focus', mute, true)
    try {
      await clear(first)
      expect(document.activeElement).toBe(open(second))
      await clear(second)
      expect(rows()[0]).toBe(third)
      expect(document.activeElement).toBe(open(third))
    } finally {
      document.removeEventListener('focusin', mute, true)
      document.removeEventListener('focus', mute, true)
    }
  })

  it("moves focus into Needs attention after a teammate's change only where Load more or the row that went had it", async () => {
    // 21 tasks need attention: the two overdue, the paused one and 18 more
    const { board } = await overview((snap) => {
      plan(snap)
      for (let n = 5; n <= 22; n++)
        snap.issues.push({ ...taskRow(snap, `p${n}`, 'todo', n), paused: true })
    })
    const task = (id: string) => board.snapshot.issues.find((t) => t.id === id)
    const pause = async (paused: boolean, ...ids: string[]) => {
      for (const id of ids) Object.assign(task(id) ?? {}, { paused })
      await board.deliver()
    }
    expect(rows()).toHaveLength(20)
    expect(document.activeElement).toBe(document.body)
    await pause(false, 'p22')
    expect(q('[data-ov-more]')).toBeNull()
    expect(document.activeElement).toBe(document.body)
    // focus went into the first row and out of the page again
    await act(async () => rows()[0]?.querySelector<HTMLElement>('[data-focus-key="row"]')?.focus())
    expect(document.activeElement?.closest('[data-need]')).toBe(rows()[0])
    await act(async () => {
      const active = document.activeElement
      if (active instanceof HTMLElement) active.blur()
    })
    Object.assign(task('later') ?? {}, { due_date: day(30) })
    await board.deliver()
    expect(rows()).toHaveLength(19)
    expect(document.activeElement).toBe(document.body)
    // Load more back, with focus on it
    await pause(true, 'p22', 'fine')
    await act(async () => q('[data-ov-more]')?.focus())
    await pause(false, 'p22', 'fine')
    expect(q('[data-ov-more]')).toBeNull()
    expect(document.activeElement).toBe(q('[data-ov-needs]'))
  })

  it("moves focus into Sub-projects after a teammate's change only where Load more had it", async () => {
    // Plan's sub-projects: One and ten more
    const { board } = await overview((snap) => {
      plan(snap)
      const base = snap.projects[0]
      for (let n = 2; n <= 11; n++)
        snap.projects.push({ ...base, id: `sub${n}`, key: `S${n}`, num: 10 + n, name: `Sub ${n}` })
    })
    const eleventh = board.snapshot.projects.find((p) => p.id === 'sub11')
    const drop = async () => {
      board.snapshot.projects = board.snapshot.projects.filter((p) => p !== eleventh)
      await board.deliver()
    }
    expect(q('[data-ov-subs-more]')).not.toBeNull()
    await drop()
    expect(q('[data-ov-subs-more]')).toBeNull()
    expect(document.querySelectorAll('[data-ov-sub]')).toHaveLength(10)
    expect(document.activeElement).toBe(document.body)
    // Load more back, with focus on it
    if (eleventh) board.snapshot.projects.push(eleventh)
    await board.deliver()
    await act(async () => q('[data-ov-subs-more]')?.focus())
    await drop()
    expect(q('[data-ov-subs-more]')).toBeNull()
    expect(document.activeElement).toBe(q('[data-ov-subs-state]'))
  })
})
