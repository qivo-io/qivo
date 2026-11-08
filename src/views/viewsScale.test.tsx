// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TODAY_WEEK, weekToISO } from '../lib/dates'
import { oracleScope } from '../store/oracleScope.setup'
import type { IssueFilters } from '../store/planner'
import type { Snapshot } from '../store/plannerFixture.setup'
import { loadBoard, loadBoardWithTasks, spread, taskRow } from './boardFixture.setup'

/* The phone's task schedule mounts its first screen at once and the rest
   in slices, the Overview's lists show the server's batches with Load
   more, the Overview's group health shows the server's rows 10 at a time,
   the store's figures for many groups read them in one pass over the
   tasks, and the Roadmap holds its figures at the design size, one figure
   a case, from its server answer, with its milestone flags from the range
   read of the weeks on screen. */

/* A list of more than SYNC_LIMIT tasks mounts in slices. These tests lower
   it from 300, so a list of LONG tasks in one sub-project, well inside the
   design size, reaches the slices. */
const { SYNC_LIMIT } = vi.hoisted(() => ({ SYNC_LIMIT: 40 }))
const LONG = 60

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
vi.mock('../lib/boardGroups', async (original) => ({
  ...(await original<typeof import('../lib/boardGroups')>()),
  SYNC_LIMIT,
}))
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

describe('a long list on another view', () => {
  it("shows the first batch of each of the Overview's lists at once, and the next on Load more", async () => {
    const board = await loadBoard(network, paused(LONG))
    const { Overview } = await import('./Overview')
    const actions = new Proxy({}, { get: () => () => {} }) as Parameters<
      typeof Overview
    >[0]['actions']
    await board.renderView(root, (info) => <Overview info={info} actions={actions} />)
    // every task is in both lists, which show a batch of 10 each, with
    // nothing left to mount in slices
    expect(count('[data-ovrow]')).toBe(10)
    expect(count('[data-atrisk]')).toBe(10)
    await finish()
    expect(count('[data-ovrow]')).toBe(10)
    await act(async () =>
      document.querySelector<HTMLElement>('[data-ov-list="paused"] [data-ov-more]')?.click(),
    )
    expect(count('[data-ovrow]')).toBe(20)
    expect(count('[data-atrisk]')).toBe(10)
  })

  it("mounts the first screen of the phone's task schedule, then the rest", async () => {
    const board = await loadBoardWithTasks(network, paused(LONG))
    const { MobileRoadmap } = await import('./MobileRoadmap')
    const { useScopeMilestones } = await import('./useScopeMilestones')
    const { AGENDA_MILESTONE_SLOTS } = await import('../store/planner')
    const noop = () => {}
    /* the agenda with its milestone sections, which the Roadmap reads and
       which read nothing while the task schedule shows */
    function Agenda({
      info,
      children,
    }: {
      info: Parameters<typeof useScopeMilestones>[0]
      children: (milestones: ReturnType<typeof useScopeMilestones>) => React.ReactNode
    }) {
      return children(useScopeMilestones(info, AGENDA_MILESTONE_SLOTS, false))
    }
    await board.renderView(root, (info) => (
      <Agenda info={info}>
        {(milestones) => (
          <MobileRoadmap
            milestones={milestones}
            info={info}
            // the Roadmap's tasks, as its answer brings them
            tasks={board.P.issues}
            filterControls={null}
            actions={{}}
            onTimeline={noop}
            onAutoCorrect={noop}
            corrections={0}
            undoControls={null}
            section="tasks"
            onSectionChange={noop}
            taskState="all"
            onTaskStateChange={noop}
          />
        )}
      </Agenda>
    ))
    expect(count('.mobile-roadmap-row')).toBeGreaterThan(0)
    expect(count('.mobile-roadmap-row')).toBeLessThanOrEqual(20)
    await finish()
    expect(count('.mobile-roadmap-row')).toBe(LONG)
  })
})

describe('an Overview row', () => {
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

describe('a delivery on the desktop Roadmap', () => {
  it('renders the rows of the task it changed, not every row', async () => {
    const board = await loadBoardWithTasks(network, (snap) => {
      // a sub-project's 300 open tasks at the design size, with due dates,
      // so every row draws its due mark when it renders
      for (let n = 1; n <= 300; n++)
        snap.issues.push({ ...taskRow(snap, `t${n}`, 'todo', n), due_date: '2026-12-01' })
      // t150 blocks t151, both scheduled, so they are a part Auto-move reads
      for (const [id, start, end] of [
        ['t150', '2026-09-14', '2026-09-21'],
        ['t151', '2026-10-12', '2026-10-19'],
      ] as const)
        Object.assign(snap.issues.find((issue) => issue.id === id) ?? {}, {
          start_week: start,
          end_week: end,
        })
      snap.links.push({
        id: 'link-1',
        source_id: 't150',
        target_id: 't151',
        type: 'blocks',
        pair_key: 't150:t151',
        created_at: '2026-09-01T08:00:00.000Z',
      })
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
    expect(count('[data-roadmap-task-top]')).toBe(300)
    // a remote rename of one task
    // a row's due mark asks whether its task tracks delay
    const drawn = vi.spyOn(board.P, 'tracksDelay')
    const before = { ...schedule }
    const row = board.snapshot.issues.find((issue) => issue.id === 't150')
    if (!row) throw new Error('missing the task')
    row.title = 'Renamed task'
    row.updated_at = new Date().toISOString()
    await board.deliver()
    expect(document.body.textContent).toContain('Renamed task')
    // the renamed task's chunk of rows, not all 300
    expect(drawn.mock.calls.length).toBeGreaterThan(0)
    expect(drawn.mock.calls.length).toBeLessThanOrEqual(64)
    // a title is neither a date nor a link: Auto-move stands, and the
    // arrows come from the dependency answer, never a walk of every task
    expect(schedule.moves).toBe(before.moves)
    expect(schedule.pairs).toBe(0)
    // a date of a part's task is: Auto-move works it out again
    const { weekToISO } = await import('../lib/dates')
    Object.assign(row, {
      start_week: weekToISO(board.P.TODAY_WEEK + 2),
      end_week: weekToISO(board.P.TODAY_WEEK + 3),
    })
    await board.deliver()
    expect(schedule.moves).toBeGreaterThan(before.moves)
    expect(
      board.P.issueById[board.P.issues.find((it) => it.uuid === 't150')?.id ?? '']?.start,
    ).toBe(board.P.TODAY_WEEK + 2)
  })

  it('renders the rows of one track on a drag of its flag in My view, and its flags alone on a rename', async () => {
    // 20 top-level projects, each with a sub-project of 3 of the person's
    // tasks due next week, so each task row draws its due mark when it
    // renders, and a milestone next week
    const board = await loadBoard(
      network,
      (snap) => {
        const base = snap.projects[0]
        snap.projects = []
        let n = 0
        for (let i = 0; i < 20; i++) {
          const top = `top-${String(i).padStart(2, '0')}`
          snap.projects.push(
            {
              ...base,
              id: top,
              type: 'meta',
              key: `T${i}`,
              num: 2 * i + 1,
              name: `Program ${top}`,
            },
            {
              ...base,
              id: `${top}-a`,
              type: 'project',
              key: `S${i}`,
              num: 2 * i + 2,
              name: `Work ${top}`,
              parent_id: top,
            },
          )
          for (let k = 0; k < 3; k++) {
            n++
            snap.issues.push({
              ...taskRow(snap, `t${n}`, 'todo', n),
              project_id: `${top}-a`,
              title: titleOf(n),
              due_date: week(1),
            })
          }
          snap.milestones.push({
            id: `ms-${top}`,
            project_id: top,
            name: `Release ${i}`,
            week: week(1),
            created_at: '2026-09-14T08:00:00.000Z',
          })
        }
      },
      { scope: 'mine' },
    )
    await renderRoadmap(board, { ...NO_FILTERS, mine: true })
    expect(roadmapState()).toBe('ok')
    const flag = (id: string) => document.querySelector<HTMLElement>(`[data-msflag="${id}"]`)
    await vi.waitFor(() => expect(flag('ms-top-00')).not.toBeNull())
    // a drag of the first track's flag, before it drops
    const drawn = vi.spyOn(board.P, 'tracksDelay')
    Element.prototype.setPointerCapture = () => {}
    const pointer = (type: string, clientX: number) =>
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX, pointerId: 1 })
    const handle = flag('ms-top-00') as HTMLElement
    await act(async () => handle.dispatchEvent(pointer('pointerdown', 100)))
    await act(async () => handle.dispatchEvent(pointer('pointermove', 136)))
    const projects = new Set(drawn.mock.calls.map(([it]) => (it as { project: string }).project))
    // that track's task rows render again with its guide, no other track's
    expect([...projects]).toEqual(['top-00-a'])
    await act(async () => handle.dispatchEvent(pointer('pointerup', 136)))
    // another person's rename of a milestone reaches the read's answer alone
    drawn.mockClear()
    const renamed = board.snapshot.milestones.find((m) => m.id === 'ms-top-05')
    if (!renamed) throw new Error('missing the milestone')
    renamed.name = 'Release five renamed'
    await board.answer()
    // the answer reaches the store through the live double, which a
    // loaded worker can take a moment to deliver
    await vi.waitFor(() => expect(flag('ms-top-05')?.textContent).toBe('Release five renamed'))
    // its track's row draws the new name; no task row renders again
    expect(drawn).not.toHaveBeenCalled()
  })

  it('keeps the rows that only shift when another task goes', async () => {
    const board = await loadBoardWithTasks(network, (snap) => {
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

/** The week `n` weeks from this one, as a stored day. */
const week = (n: number) => weekToISO(TODAY_WEEK + n)

/** About 80 characters of ordinary text, the title of task `n`. */
const titleOf = (n: number) =>
  `Prepare the quarterly review of supplier contracts and delivery terms, item ${n}`

/** The filter row with nothing on, or My view's own. */
const NO_FILTERS: IssueFilters = {
  mine: false,
  assignees: [],
  priority: null,
  stale: false,
  focus: false,
  search: '',
}

/** Renders the desktop Roadmap of the board's scope with `filters`, in
    the shell whose toolbar row its toolbar portals into. */
async function renderRoadmap(
  board: Awaited<ReturnType<typeof loadBoard>>,
  filters: IssueFilters = NO_FILTERS,
) {
  const { Roadmap } = await import('./Roadmap')
  const { WorkspaceShell } = await import('../components/WorkspaceShell')
  const actions = new Proxy({}, { get: () => () => {} }) as Parameters<typeof Roadmap>[0]['actions']
  await board.renderView(root, (info) => (
    <WorkspaceShell header={null}>
      <Roadmap
        info={info}
        filters={filters}
        actions={actions}
        filterControls={() => null}
        focusPlan={null}
      />
    </WorkspaceShell>
  ))
}

const roadmapState = () =>
  document.querySelector<HTMLElement>('[data-roadmap-root]')?.dataset.roadmapState

/** `n` people of the organization besides the fixture's, by id. */
function people(snap: Snapshot, n: number): string[] {
  const ids = [snap.profiles[0].id]
  for (let i = 1; i < n; i++) {
    const id = `person-${String(i).padStart(2, '0')}`
    snap.profiles.push({
      ...snap.profiles[0],
      id,
      auth_user_id: undefined,
      name: `Person ${i}`,
      initials: 'PE',
      org_role: 'user',
    })
    ids.push(id)
  }
  return ids
}

/** Plan, a top-level project over One (the fixture's), Two and Three,
    holding a project's design size at its sum: 800 open and 200 Done
    tasks, 267, 267 and 266 open and 67, 67 and 66 Done a sub-project.
    Each task has an ordinary title, an everyday span of one or two weeks
    inside the Roadmap's first window, 4 hours left while open, and one of
    40 owners in turn, about 25 tasks a person. */
const designProject = (snap: Snapshot) => {
  const base = snap.projects[0]
  snap.projects.push({ ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 2, name: 'Plan' })
  Object.assign(base, { parent_id: 'plan', name: 'One' })
  snap.projects.push(
    { ...base, id: 'two', key: 'TWO', num: 3, name: 'Two' },
    { ...base, id: 'three', key: 'THR', num: 4, name: 'Three' },
  )
  const owners = people(snap, 40)
  let n = 0
  for (const [project, open, done] of [
    [base.id, 267, 67],
    ['two', 267, 67],
    ['three', 266, 66],
  ] as const)
    for (let i = 0; i < open + done; i++) {
      n++
      const start = (n % 6) - 1
      snap.issues.push({
        ...taskRow(snap, `t${n}`, i < open ? 'todo' : 'done', n),
        project_id: project,
        title: titleOf(n),
        assignee_id: owners[n % owners.length],
        ...(i < open ? { remaining_hours: 4, remaining_set_at: new Date().toISOString() } : {}),
        start_week: week(start),
        end_week: week(start + (n % 2)),
      })
    }
}

/* Each case keeps to vitest's default timeout (vitest.config.mts). On 6
   November 2026 the three cases at 1,000 rows took 4.0 to 5.3 s each, the
   others under 0.4 s, on a large Boat sandbox. */
describe('the Roadmap at the design size', () => {
  it("shows a project's 800 open and 200 Done tasks at their sum, walking no list of the workspace's", async () => {
    const board = await loadBoard(network, designProject, { scope: 'plan' })
    // the store's whole-list readers, which throw before every task is held
    // (store/planner.ts wholeListRead)
    const scoped = vi.spyOn(board.P, 'scopedIssues')
    const remaining = vi.spyOn(board.P, 'remainingByGroups')
    const groupsRead = vi.spyOn(board.P, 'issuesInGroups')
    const issues = vi.spyOn(board.P, 'issues', 'get')
    await renderRoadmap(board)
    expect(roadmapState()).toBe('ok')
    expect(count('[data-roadmap-task-top]')).toBe(1000)
    // the headings read the answer's counts, 267 or 266 open tasks of 4
    // hours a sub-project
    const headings = [...document.querySelectorAll('[data-track]')].map((el) => el.textContent)
    expect(headings.join(' ')).toContain('1068h')
    expect(headings.join(' ')).toContain('1064h')
    expect(board.P.tasksHeld()).toBe(false)
    expect(scoped).not.toHaveBeenCalled()
    expect(remaining).not.toHaveBeenCalled()
    expect(groupsRead).not.toHaveBeenCalled()
    expect(issues).not.toHaveBeenCalled()
  })

  it("spreads Team over the owners of a design-size project's rows, every cell a figure", async () => {
    const board = await loadBoard(network, designProject, { scope: 'plan' })
    await renderRoadmap(board)
    const rows = [...document.querySelectorAll<HTMLElement>('[data-res-row]')]
    expect(rows).toHaveLength(40)
    // the owners' hours come with their faces (people.byIds), as the store
    // holds nobody but the signed-in person, and show in the store's next
    // frame
    await vi.waitFor(
      async () => {
        await finish()
        expect(board.P.person('person-39')?.state).toBe('ok')
      },
      { timeout: 20_000 },
    )
    await finish()
    for (const row of document.querySelectorAll<HTMLElement>('[data-res-row]')) {
      const cells = [...row.querySelectorAll<HTMLElement>('[data-load-box]')]
      expect(cells.length).toBeGreaterThan(0)
      for (const cell of cells) {
        expect(cell.dataset.loadUnknown, row.dataset.resRow).toBeUndefined()
        expect(cell.dataset.loadWaiting, row.dataset.resRow).toBeUndefined()
        expect(cell.dataset.loadPct ?? 'none', row.dataset.resRow).toMatch(/^\d+$/)
      }
    }
    // each person's open tasks fill some weeks: no row reads as free time
    for (const row of rows)
      expect(
        [...row.querySelectorAll<HTMLElement>('[data-load-box]')].some(
          (cell) => Number(cell.dataset.loadHours) > 0,
        ),
        row.dataset.resRow,
      ).toBe(true)
  })

  it("shows My view at the ceiling, 1,000 of the person's own subtasks", async () => {
    const subtasks: string[] = []
    const board = await loadBoard(
      network,
      (snap) => {
        // 40 sub-projects, 3 to a top-level project, each with 30 open
        // tasks: 5 tasks with subtasks another person owns, and their 25
        // subtasks the person owns
        const base = snap.projects[0]
        const [me, lead] = people(snap, 2)
        let n = 0
        for (let s = 0; s < 40; s++) {
          const top = `top${Math.floor(s / 3)}`
          if (s % 3 === 0)
            snap.projects.push({
              ...base,
              id: top,
              type: 'meta',
              // a top-level project, whatever the base holds by then
              parent_id: undefined,
              key: `T${s}`,
              num: 100 + s,
              name: `Top ${s / 3}`,
            })
          const sub = s === 0 ? base.id : `sub${s}`
          if (s === 0) Object.assign(base, { parent_id: top })
          else
            snap.projects.push({
              ...base,
              id: sub,
              key: `S${s}`,
              num: 200 + s,
              name: `Sub ${s}`,
              parent_id: top,
            })
          for (let g = 0; g < 5; g++) {
            const group = `g${s}-${g}`
            snap.issues.push({
              ...taskRow(snap, group, 'todo', ++n),
              project_id: sub,
              title: titleOf(n),
              assignee_id: lead,
            })
            for (let k = 0; k < 5; k++) {
              const id = `${group}-${k}`
              subtasks.push(id)
              snap.issues.push({
                ...taskRow(snap, id, 'todo', ++n),
                project_id: sub,
                parent_id: group,
                title: titleOf(n),
                assignee_id: me,
                remaining_hours: 2,
              })
            }
          }
        }
      },
      { scope: 'mine' },
    )
    expect(subtasks).toHaveLength(1000)
    await renderRoadmap(board, { ...NO_FILTERS, mine: true })
    expect(roadmapState()).toBe('ok')
    // every subtask of the person's has its row
    const shown = new Set(
      [...document.querySelectorAll<HTMLElement>('[data-roadmap-task-open]')].map(
        (el) => el.dataset.roadmapTaskOpen,
      ),
    )
    const missing = subtasks.filter(
      (uuid) => !shown.has(board.P.viewTask('roadmap', uuid)?.id ?? uuid),
    )
    expect(missing).toEqual([])
  })

  it("reads the flags of My view's 200 top-level projects in one read, each on its own row", async () => {
    // the projects figure at its design size: 200 top-level projects, each
    // with one sub-project, so the person reads exactly 200 sub-projects,
    // that figure's design size too. The Roadmap's answer and the range
    // read over its tracks each cover both figures at their sum. Each
    // sub-project holds one task of the person's, each project one
    // milestone next week
    const board = await loadBoard(
      network,
      (snap) => {
        const base = snap.projects[0]
        snap.projects = []
        for (let i = 0; i < 200; i++) {
          const top = `top-${String(i).padStart(3, '0')}`
          snap.projects.push(
            {
              ...base,
              id: top,
              type: 'meta',
              key: `T${i}`,
              num: 2 * i + 1,
              name: `Program ${top}`,
            },
            {
              ...base,
              id: `${top}-a`,
              type: 'project',
              key: `S${i}`,
              num: 2 * i + 2,
              name: `Work ${top}`,
              parent_id: top,
            },
          )
          snap.issues.push({
            ...taskRow(snap, `t${i}`, 'todo', i + 1),
            project_id: `${top}-a`,
            title: titleOf(i + 1),
          })
          snap.milestones.push({
            id: `ms-${top}`,
            project_id: top,
            name: `Release ${i}`,
            week: week(1),
            created_at: '2026-09-14T08:00:00.000Z',
          })
        }
      },
      { scope: 'mine' },
    )
    await renderRoadmap(board, { ...NO_FILTERS, mine: true })
    expect(roadmapState()).toBe('ok')
    const reads = board.server.milestones.asked.filter((a) => a.name === 'milestones:between')
    expect(reads).toHaveLength(1)
    expect((reads[0].args as { projects: string[] }).projects).toHaveLength(200)
    expect(
      document.querySelector('[data-roadmap-root]')?.getAttribute('data-roadmap-milestones'),
    ).toBe('ok')
    expect(count('[data-msband]')).toBe(0)
    for (let i = 0; i < 200; i++) {
      const top = `top-${String(i).padStart(3, '0')}`
      expect(
        document.querySelector(`[data-track="${top}"] [data-msflag="ms-${top}"]`),
        top,
      ).not.toBeNull()
    }
  })

  /** One top-level project, Plan, over the fixture's sub-project with one
      task of the person's, and a milestone in each of the 260 weeks of
      the window's maximum from this week on, which the Roadmap shows. */
  const weekly = (snap: Snapshot) => {
    const base = snap.projects[0]
    snap.projects.push({ ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 2, name: 'Plan' })
    Object.assign(base, { parent_id: 'plan', name: 'One' })
    snap.issues.push({ ...taskRow(snap, 't1', 'todo', 1), title: titleOf(1) })
    for (let n = 0; n < 260; n++)
      snap.milestones.push({
        id: `ms-${n}`,
        project_id: 'plan',
        name: `Weekly check ${n + 1}`,
        week: week(n),
        created_at: '2026-09-14T08:00:00.000Z',
      })
  }
  /** Where each flag's diamond stands, in pixels from the timeline's start. */
  const diamondsAt = (flags: HTMLElement[]) =>
    flags.map((flag) => {
      if (flag.style.left) return Number.parseFloat(flag.style.left) + 4.5
      const right = /calc\(100% - ([\d.]+)px\)/.exec(flag.style.right)
      return Number(right?.[1]) - 4.5
    })
  /** Checks the window's 260 flags, each in its place within `within`,
      apart from its neighbours and in the tab order. */
  const checkWeekly = (within: string) => {
    const flags = [...document.querySelectorAll<HTMLElement>('[data-msflag]')]
    expect(flags).toHaveLength(260)
    for (const flag of flags) {
      expect(flag.closest(within), flag.dataset.msflag).not.toBeNull()
      expect(flag.tabIndex).toBe(0)
      expect(flag.getAttribute('role')).toBe('button')
    }
    const xs = diamondsAt(flags).sort((a, b) => a - b)
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(9)
  }
  const WINDOW_260 = {
    start: { mode: 'weeks', value: 0 },
    end: { mode: 'weeks', value: 259 },
  } as const

  it("draws 260 weeks of one project's milestones on its row in My view, each in its place", async () => {
    const board = await loadBoard(network, weekly, { scope: 'mine' })
    board.P.saveUINow({ roadmapWin: WINDOW_260 })
    await renderRoadmap(board, { ...NO_FILTERS, mine: true })
    expect(roadmapState()).toBe('ok')
    await vi.waitFor(() => expect(count('[data-msflag]')).toBe(260))
    checkWeekly('[data-track="plan"]')
  })

  it("draws 260 weeks of one project's milestones in its header, each in its place", async () => {
    const board = await loadBoard(network, weekly, { scope: 'plan' })
    board.P.saveUINow({ roadmapWin: WINDOW_260 })
    await renderRoadmap(board)
    expect(roadmapState()).toBe('ok')
    await vi.waitFor(() => expect(count('[data-msflag]')).toBe(260))
    checkWeekly('[data-msband]')
  })

  it('shows the ceiling note one row past a lowered ceiling, and the rows at it', async () => {
    // Plan over three sub-projects of 30 open tasks, 90 rows
    const board = await loadBoard(network, spread(30), { scope: 'plan' })
    board.server.roadmap.ceiling = 89
    await renderRoadmap(board)
    expect(roadmapState()).toBe('over_ceiling')
    expect(document.querySelector('[data-empty-state-title]')?.textContent).toBe(
      "This selection exceeds the Roadmap's 1,000-task limit.",
    )
    const choices = [...document.querySelectorAll<HTMLElement>('[data-roadmap-choice]')].map(
      (el) => el.dataset.roadmapChoice,
    )
    expect(choices.sort()).toEqual([board.snapshot.projects[0].id, 'three', 'two'].sort())
    expect(count('[data-roadmap-task-top]')).toBe(0)
    board.server.roadmap.ceiling = 90
    await board.answer()
    expect(roadmapState()).toBe('ok')
    expect(count('[data-roadmap-task-top]')).toBe(90)
  })

  it("disables Auto-move past a lowered size of the selection's dependency parts", async () => {
    // 30 tasks of one sub-project in one chain, each blocking the next,
    // all in this week, so Auto-move has 29 moves
    const board = await loadBoard(network, (snap) => {
      for (let n = 1; n <= 30; n++) {
        snap.issues.push({
          ...taskRow(snap, `t${n}`, 'todo', n),
          title: titleOf(n),
          start_week: week(0),
          end_week: week(0),
        })
        if (n > 1)
          snap.links.push({
            id: `link-${n}`,
            source_id: `t${n - 1}`,
            target_id: `t${n}`,
            type: 'blocks',
            pair_key: `t${n - 1}:t${n}`,
            created_at: `2026-09-01T08:${String(n).padStart(2, '0')}:00.000Z`,
          })
      }
    })
    board.server.roadmap.partTasks = 29
    await renderRoadmap(board)
    const button = () => document.querySelector<HTMLButtonElement>('[data-auto-correct]')
    expect(roadmapState()).toBe('ok')
    expect(button()?.disabled).toBe(true)
    expect(button()?.dataset.autoMove).toBe('over_budget')
    // at the part's size its inputs are whole, and it offers the moves
    board.server.roadmap.partTasks = 30
    await board.answer()
    expect(button()?.disabled).toBe(false)
    expect(button()?.dataset.autoMove).toBeUndefined()
    expect(button()?.textContent).toContain('29')
  })
})

describe("Team sync's opening", () => {
  it('takes its loading marks with it when it goes before its lists finish', async () => {
    const board = await loadBoardWithTasks(network, (snap) => {
      // urgent tasks with no owner: Needs an owner mounts in slices
      for (let n = 1; n <= LONG; n++)
        snap.issues.push({
          ...taskRow(snap, `t${n}`, 'todo', n),
          assignee_id: undefined,
          priority: 'urgent',
        })
    })
    const { TeamOpening } = await import('./teamSync/TeamOpening')
    const { syncDay } = await import('../lib/teamSync')
    let show = true
    const view = (_info: Parameters<Parameters<typeof board.renderView>[1]>[0]) => (
      <div data-scroll data-sync-page>
        {show && (
          <TeamOpening
            rows={board.P.issues}
            tasks={board.P.issues}
            humans={[]}
            subIds={new Set(board.P.issues.map((it) => it.project))}
            metaIds={new Set()}
            day={syncDay(Date.now())}
            now={Date.now()}
            onOpenTask={() => {}}
            verdictOf={() => null}
            blockedOf={() => []}
            loadOf={() => ({ state: 'unknown' })}
          />
        )}
      </div>
    )
    await board.renderView(root, view)
    const page = () => document.querySelector('[data-sync-page]')
    expect(count('[data-sync-needs-owner]')).toBeLessThan(LONG)
    expect(page()?.getAttribute('aria-busy')).toBe('true')
    // the walk moves on to a person's page while the list still mounts
    show = false
    await board.renderView(root, view)
    expect(page()?.hasAttribute('aria-busy')).toBe(false)
    expect(page()?.hasAttribute('data-board-mount')).toBe(false)
  })
})

/* Plan, a parent project over 30 sub-projects, the design size, with a task
   each. */
const groups = (snap: Snapshot) => {
  const base = snap.projects[0]
  snap.projects.push({ ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 2, name: 'Plan' })
  Object.assign(base, { parent_id: 'plan' })
  for (let n = 1; n <= 30; n++) {
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

describe("the Overview's group health", () => {
  it('shows 30 groups 10 rows at a time from the server, with no pass over the tasks', async () => {
    const board = await loadBoard(network, groups, { scope: 'plan' })
    const { Overview } = await import('./Overview')
    const actions = new Proxy({}, { get: () => () => {} }) as Parameters<
      typeof Overview
    >[0]['actions']
    // the store's whole-list readers, which a read before every task is held
    // would throw from too (store/planner.ts wholeListRead)
    const groupsRead = vi.spyOn(board.P, 'issuesInGroups')
    const remaining = vi.spyOn(board.P, 'remainingByGroups')
    const scoped = vi.spyOn(board.P, 'scopedIssues')
    await board.renderView(root, (info) => <Overview info={info} actions={actions} />)
    expect(count('[data-ov-strip]')).toBe(1)
    expect(count('[data-ovcard]')).toBe(10)
    for (const rows of [20, 30]) {
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[data-ov-health-more]')?.click(),
      )
      expect(count('[data-ovcard]')).toBe(rows)
    }
    expect(count('[data-ov-health-more]')).toBe(0)
    // the scope's completion is the server's summary, the rows' figures the
    // server's health table, and nothing on the page walks the tasks, which
    // the workspace does not hold
    expect(board.P.tasksHeld()).toBe(false)
    expect(groupsRead).not.toHaveBeenCalled()
    expect(remaining).not.toHaveBeenCalled()
    expect(scoped).not.toHaveBeenCalled()
  })
})

/** Numbers from [0, 1), the same on every run. */
function seeded(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
}

describe('figures for many groups at once', () => {
  it('equal progressIn and remainingIn for every group', async () => {
    const random = seeded(7)
    const statuses = ['backlog', 'todo', 'progress', 'review', 'done'] as const
    const board = await loadBoardWithTasks(
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
        // tasks, fractional hours and tasks without an estimate, 20 tasks a
        // sub-project
        for (let n = 1; n <= 600; n++) {
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
    const info = oracleScope(board.snapshot, 'plan')
    if (!info) throw new Error('missing the scope')
    // the scope's groups, a few overlapping lists, and an empty one
    const lists = [
      ...info.groups.map((g) => g.subIds),
      info.subIds,
      info.subIds.slice(3, 9),
      [info.subIds[0], info.subIds[0]],
      [],
    ]
    // the Overview's oracle holds the one-group sums the store gave up
    const { progressByGroups, progressIn, remainingIn } = await import(
      '../store/overviewOracle.setup'
    )
    const mine = (it: { owner: string | null }) => it.owner === P.issues[0].owner
    for (const only of [null, mine]) {
      expect(progressByGroups(lists, only)).toEqual(lists.map((l) => progressIn(l, only)))
      expect(P.remainingByGroups(lists, only)).toEqual(lists.map((l) => remainingIn(l, only)))
    }
  })
})
