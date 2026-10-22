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

describe('a long list on another view', { timeout: BOARD_TEST_TIMEOUT * 2 }, () => {
  it('mounts the first screen of the Overview, then the rest in slices', async () => {
    const board = await loadBoard(network, paused(600))
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
    expect(count('[data-ovrow]')).toBe(600)
    expect(count('[data-atrisk]')).toBe(600)
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
