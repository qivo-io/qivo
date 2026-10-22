// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Snapshot } from '../store/plannerFixture.setup'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* The Overview's task lists and the phone's task schedule mount their
   first screen at once and the rest in slices, and the Overview's group
   health reads every group's figures in one pass over the tasks. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
// the Roadmap's work over every task, counted
const schedule = vi.hoisted(() => ({ moves: 0, pairs: 0 }))
vi.mock('../lib/schedule', async (original) => {
  const actual = await original<typeof import('../lib/schedule')>()
  return {
    ...actual,
    autoMoves: (...args: Parameters<typeof actual.autoMoves>) => {
      schedule.moves++
      return actual.autoMoves(...args)
    },
    dependencyPairs: (...args: Parameters<typeof actual.dependencyPairs>) => {
      schedule.pairs++
      return actual.dependencyPairs(...args)
    },
  }
})
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

let container: HTMLDivElement
let root: Root
let slices: (() => void)[]

beforeEach(() => {
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
  slices = []
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1: { onmessage: (() => void) | null; close: () => void } = {
        onmessage: null,
        close: () => {},
      }
      port2 = { postMessage: () => slices.push(() => this.port1.onmessage?.()) }
    },
  )
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    slices.push(() => callback(performance.now())),
  )
  vi.stubGlobal('innerHeight', 400)
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const finish = async () => {
  while (slices.length) await act(async () => slices.shift()?.())
}
const count = (selector: string) => document.querySelectorAll(selector).length

/** `n` paused tasks, overdue since last year. */
const paused = (n: number) => (snap: Snapshot) => {
  for (let i = 1; i <= n; i++)
    snap.issues.push({ ...taskRow(snap, `t${i}`, 'todo', i), paused: true, due_date: '2025-01-15' })
}

describe('a long list on another view', { timeout: BOARD_TEST_TIMEOUT * 4 }, () => {
  it('mounts the first screen of the Overview, then the rest in slices', async () => {
    const board = await loadBoard(network, paused(350))
    const { Overview } = await import('./Overview')
    const actions = new Proxy({}, { get: () => () => {} }) as Parameters<
      typeof Overview
    >[0]['actions']
    await board.renderView(root, (info) => <Overview info={info} actions={actions} />)
    // each list mounts its first 900px of rows; every task is in both
    expect(count('[data-ovrow]')).toBeGreaterThan(0)
    expect(count('[data-ovrow]')).toBeLessThanOrEqual(20)
    expect(count('[data-atrisk]')).toBeLessThanOrEqual(20)
    await finish()
    expect(count('[data-ovrow]')).toBe(350)
    expect(count('[data-atrisk]')).toBe(350)
  })

  it("mounts the first screen of the phone's task schedule, then the rest", async () => {
    const board = await loadBoard(network, paused(600))
    const { MobileRoadmap } = await import('./MobileRoadmap')
    const noop = () => {}
    await board.renderView(root, (info) => (
      <MobileRoadmap
        info={info}
        windowStart={board.P.TODAY_WEEK - 4}
        windowEnd={board.P.TODAY_WEEK + 12}
        filters={{
          mine: false,
          assignees: [],
          priority: null,
          stale: false,
          focus: false,
          search: '',
        }}
        filterControls={null}
        actions={{}}
        onTimeline={noop}
        onUpdateEstimate={noop}
        onAutoCorrect={noop}
        corrections={0}
        undoControls={null}
        section="tasks"
        onSectionChange={noop}
        taskState="all"
        onTaskStateChange={noop}
      />
    ))
    expect(count('.mobile-roadmap-row')).toBeGreaterThan(0)
    expect(count('.mobile-roadmap-row')).toBeLessThanOrEqual(20)
    await finish()
    expect(count('.mobile-roadmap-row')).toBe(600)
  })
})

describe('an Overview row', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('keeps keyboard focus when focus makes it live', async () => {
    const board = await loadBoard(network, paused(3))
    const { Overview } = await import('./Overview')
    const actions = new Proxy({}, { get: () => () => {} }) as Parameters<
      typeof Overview
    >[0]['actions']
    await board.renderView(root, (info) => <Overview info={info} actions={actions} />)
    const row = () => document.querySelector<HTMLElement>('[data-ovrow]')
    const before = row()
    expect(before?.closest('[data-card-live]')).toBeNull()
    await act(async () => before?.focus())
    // the live row's button carries its tooltip, so it is a new element
    expect(row()?.closest('[data-card-live]')).not.toBeNull()
    expect(row()).not.toBe(before)
    expect(document.activeElement).toBe(row())
  })
})

describe('a delivery on the desktop Roadmap', { timeout: BOARD_TEST_TIMEOUT * 2 }, () => {
  it('renders the rows of the task it changed, not every row', async () => {
    const board = await loadBoard(network, (snap) => {
      // due dates, so every row draws its due mark when it renders
      for (let n = 1; n <= 600; n++)
        snap.issues.push({ ...taskRow(snap, `t${n}`, 'todo', n), due_date: '2026-12-01' })
    })
    const { Roadmap } = await import('./Roadmap')
    const actions = new Proxy({}, { get: () => () => {} }) as Parameters<
      typeof Roadmap
    >[0]['actions']
    await board.renderView(root, (info) => (
      <Roadmap
        info={info}
        filters={{
          mine: false,
          assignees: [],
          priority: null,
          stale: false,
          focus: false,
          search: '',
        }}
        actions={actions}
        filterControls={() => null}
        focusPlan={null}
      />
    ))
    expect(count('[data-roadmap-task-top]')).toBe(600)
    // a remote rename of one task
    // a row's due mark asks whether its task tracks delay
    const drawn = vi.spyOn(board.P, 'tracksDelay')
    const before = { ...schedule }
    const row = board.snapshot.issues.find((issue) => issue.id === 't300')
    if (!row) throw new Error('missing the task')
    row.title = 'Renamed task'
    row.updated_at = new Date().toISOString()
    await board.deliver()
    expect(document.body.textContent).toContain('Renamed task')
    // the renamed task's chunk of rows, not all 600
    expect(drawn.mock.calls.length).toBeGreaterThan(0)
    expect(drawn.mock.calls.length).toBeLessThanOrEqual(64)
    // a title is neither a date nor a link: Auto-move and the arrows stand
    expect(schedule.moves).toBe(before.moves)
    expect(schedule.pairs).toBe(before.pairs)
    // a date is: Auto-move works it out again
    const { weekToISO } = await import('../lib/dates')
    Object.assign(row, {
      start_week: weekToISO(board.P.TODAY_WEEK + 2),
      end_week: weekToISO(board.P.TODAY_WEEK + 3),
    })
    await board.deliver()
    expect(schedule.moves).toBeGreaterThan(before.moves)
    expect(
      board.P.issueById[board.P.issues.find((it) => it.uuid === 't300')?.id ?? '']?.start,
    ).toBe(board.P.TODAY_WEEK + 2)
  })

  it('keeps the rows that only shift when another task goes', async () => {
    const board = await loadBoard(network, (snap) => {
      for (let n = 1; n <= 100; n++) snap.issues.push(taskRow(snap, `t${n}`, 'todo', n))
    })
    const { Roadmap } = await import('./Roadmap')
    const actions = new Proxy({}, { get: () => () => {} }) as Parameters<
      typeof Roadmap
    >[0]['actions']
    await board.renderView(root, (info) => (
      <Roadmap
        info={info}
        filters={{
          mine: false,
          assignees: [],
          priority: null,
          stale: false,
          focus: false,
          search: '',
        }}
        actions={actions}
        filterControls={() => null}
        focusPlan={null}
      />
    ))
    const rows = () => [...document.querySelectorAll<HTMLElement>('[data-roadmap-task-top]')]
    const before = rows()
    expect(before).toHaveLength(100)
    // the first task goes; the 99 after it move up one place, across chunks
    board.snapshot.issues.splice(
      board.snapshot.issues.findIndex((issue) => issue.id === 't1'),
      1,
    )
    await board.deliver()
    const after = rows()
    expect(after).toHaveLength(99)
    for (const row of after) expect(before).toContain(row)
  })
})

describe("Team sync's opening", { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('takes its loading marks with it when it goes before its lists finish', async () => {
    const board = await loadBoard(network, (snap) => {
      // 400 urgent tasks with no owner: Needs an owner mounts in slices
      for (let n = 1; n <= 400; n++)
        snap.issues.push({
          ...taskRow(snap, `t${n}`, 'todo', n),
          assignee_id: undefined,
          priority: 'urgent',
        })
    })
    const { TeamOpening } = await import('./teamSync/TeamOpening')
    const { syncDay } = await import('../lib/teamSync')
    let show = true
    const view = (info: Parameters<Parameters<typeof board.renderView>[1]>[0]) => (
      <div data-scroll data-sync-page>
        {show && (
          <TeamOpening
            rows={board.P.issues}
            humans={board.P.users}
            subIds={info.subIdSet}
            metaIds={new Set()}
            day={syncDay(Date.now())}
            now={Date.now()}
            onOpenTask={() => {}}
          />
        )}
      </div>
    )
    await board.renderView(root, view)
    const page = () => document.querySelector('[data-sync-page]')
    expect(count('[data-sync-needs-owner]')).toBeLessThan(400)
    expect(page()?.getAttribute('aria-busy')).toBe('true')
    // the walk moves on to a person's page while the list still mounts
    show = false
    await board.renderView(root, view)
    expect(page()?.hasAttribute('aria-busy')).toBe(false)
    expect(page()?.hasAttribute('data-board-mount')).toBe(false)
  })
})

/* Plan, a parent project over 1,000 sub-projects with a task each. */
const groups = (snap: Snapshot) => {
  const base = snap.projects[0]
  snap.projects.push({ ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 2, name: 'Plan' })
  Object.assign(base, { parent_id: 'plan' })
  for (let n = 1; n <= 1000; n++) {
    const id = n === 1 ? base.id : `sub${n}`
    if (n > 1)
      snap.projects.push({
        ...base,
        id,
        key: `S${n}`,
        num: n + 2,
        name: `Sub ${n}`,
        parent_id: 'plan',
      })
    snap.issues.push({
      ...taskRow(snap, `t${n}`, n % 3 ? 'todo' : 'done', n),
      project_id: id,
      remaining_hours: n % 7,
      remaining_set_at: new Date().toISOString(),
    })
  }
}

describe("the Overview's group health", { timeout: BOARD_TEST_TIMEOUT * 2 }, () => {
  it('reads 1,000 groups without a pass over the tasks per group', async () => {
    const board = await loadBoard(network, groups, { scope: 'plan' })
    const { Overview } = await import('./Overview')
    const actions = new Proxy({}, { get: () => () => {} }) as Parameters<
      typeof Overview
    >[0]['actions']
    const progress = vi.spyOn(board.P, 'progressIn')
    const remaining = vi.spyOn(board.P, 'remainingIn')
    await board.renderView(root, (info) => <Overview info={info} actions={actions} />)
    expect(count('[data-ov-strip]')).toBe(1)
    // only for the scope's own completion; no group row asks
    expect(progress).toHaveBeenCalled()
    for (const [subIds] of progress.mock.calls) expect(subIds).toHaveLength(1000)
    expect(remaining).not.toHaveBeenCalled()
  })
})

/** Numbers from [0, 1), the same on every run. */
function seeded(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
}

describe('figures for many groups at once', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('equal progressIn and remainingIn for every group', async () => {
    const random = seeded(7)
    const statuses = ['backlog', 'todo', 'progress', 'review', 'done'] as const
    const board = await loadBoard(
      network,
      (snap) => {
        const base = snap.projects[0]
        snap.projects.push({ ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 2, name: 'Plan' })
        Object.assign(base, { parent_id: 'plan' })
        for (let n = 2; n <= 30; n++)
          snap.projects.push({
            ...base,
            id: `sub${n}`,
            key: `S${n}`,
            num: n + 1,
            parent_id: 'plan',
          })
        const ids = snap.projects.filter((p) => p.parent_id === 'plan').map((p) => p.id)
        // the varied workspace's mix: every status, a parent for every 25
        // tasks, fractional hours and tasks without an estimate
        for (let n = 1; n <= 2000; n++) {
          const parent = n % 25 === 0 ? undefined : `t${Math.ceil(n / 25) * 25}`
          snap.issues.push({
            ...taskRow(snap, `t${n}`, statuses[Math.floor(random() * 5)], n),
            project_id: ids[Math.floor(random() * ids.length)],
            parent_id: random() < 0.3 ? parent : undefined,
            assignee_id: random() < 0.5 ? snap.profiles[0].id : undefined,
            ...(random() < 0.8
              ? {
                  remaining_hours: Math.round(random() * 400) / 10,
                  remaining_set_at: new Date().toISOString(),
                }
              : {}),
          })
        }
      },
      { scope: 'plan' },
    )
    const { P } = board
    const info = P.scopeInfo('plan')
    if (!info) throw new Error('missing the scope')
    // the scope's groups, a few overlapping lists, and an empty one
    const lists = [
      ...info.groups.map((g) => g.subIds),
      info.subIds,
      info.subIds.slice(3, 9),
      [info.subIds[0], info.subIds[0]],
      [],
    ]
    const mine = (it: { owner: string | null }) => it.owner === P.issues[0].owner
    for (const only of [null, mine]) {
      expect(P.progressByGroups(lists, only)).toEqual(lists.map((l) => P.progressIn(l, only)))
      expect(P.remainingByGroups(lists, only)).toEqual(lists.map((l) => P.remainingIn(l, only)))
    }
  })
})
