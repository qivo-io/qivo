// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Snapshot } from './store/plannerFixture.setup'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './views/boardFixture.setup'

/* The people every page shows, as the profile cache names and paints them
   (store/profileCache.ts, store/planner.ts P.person): a person the
   workspace's people part does not hold shows as loading, then by name once
   people.byIds answers, never as Unassigned, "Unknown user" or "Unavailable
   user" until the answer leaves them out; and the audit, one case a page:
   every portrait a page renders ([data-avatar]) is of a person an open view
   names (usePeople), so a host that forgets to name its people fails here.
   The caller's own seats are the workspace's always, and the view filter's
   Assignee menu, which names no one, is not open in any case. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('./lib/convex', async () => ({
  convex: network,
  live: (await import('./store/guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('./lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

let container: HTMLDivElement
let root: Root

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
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return []
      }
    },
  )
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.scrollTo = () => {}
  localStorage.clear()
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

type Board = Awaited<ReturnType<typeof loadBoard>>

/** Gina and Hal, people of the organization the workspace's people part
    does not hold, who own work the views show. */
const GINA = 'gina'
const HAL = 'hal'
const unheld = (snap: Snapshot) => {
  for (const [id, name, initials] of [
    [GINA, 'Gina Ghost', 'GG'],
    [HAL, 'Hal Hidden', 'HH'],
  ] as const)
    snap.profiles.push({
      ...snap.profiles[0],
      id,
      auth_user_id: `account-${id}`,
      name,
      initials,
      org_role: 'user',
      kind: 'person',
      plannable_hours: 30,
    })
}

/** Loads the Board's store with `prepare`, Gina and Hal left out of the
    people part and their faces held back, and records what the views
    name. */
async function load(prepare: (snap: Snapshot) => void, options: Parameters<typeof loadBoard>[2]) {
  const board = await loadBoard(
    network,
    (snap) => {
      unheld(snap)
      prepare(snap)
    },
    options,
  )
  board.server.people.unheld = new Set([GINA, HAL])
  board.server.people.hold = true
  await board.deliver()
  const names = watchNames(board)
  return { board, names }
}

/** What the open views name now, followed through P.namePeople. */
function watchNames(board: Board) {
  const owners = new Map<string, Set<string>>()
  const real = board.P.namePeople
  vi.spyOn(board.P, 'namePeople').mockImplementation((owner, people) => {
    if (people.length === 0) owners.delete(owner)
    else owners.set(owner, new Set(people.map((p) => p.id)))
    return real(owner, people)
  })
  return {
    /** the portraits on the page whose person no open view names, the
        caller's own seats left out */
    unnamed: () => {
      const named = new Set([...owners.values()].flatMap((ids) => [...ids]))
      const own = new Set(board.P.myProfileIds)
      return [...document.querySelectorAll<HTMLElement>('[data-avatar]')]
        .map((el) => el.dataset.avatar ?? '')
        .filter((id) => id && !named.has(id) && !own.has(id))
    },
  }
}

/** Lets the store's frame-batched repaint and React run. */
const repaint = async () => {
  for (let i = 0; i < 3; i++) await act(async () => await new Promise((r) => setTimeout(r, 30)))
}

/** The portraits of person `id`, by their state. */
const portraits = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(`[data-avatar="${id}"]`)].map(
    (el) => el.dataset.avatarState ?? 'ok',
  )

const WORDS_BEFORE_ANSWER = ['Unknown user', 'Unavailable user', 'Unknown person']

describe('people the workspace does not hold, on each page', () => {
  it(
    'names the Board’s lanes and cards loading and then by name, never unknown before the answer, and names every portrait',
    async () => {
      const { board, names } = await load(
        (snap) => {
          snap.issues.push({ ...taskRow(snap, 'g1', 'todo', 1), assignee_id: GINA })
          snap.issues.push({ ...taskRow(snap, 'h1', 'progress', 2), assignee_id: HAL })
          snap.issues.push({ ...taskRow(snap, 'm1', 'todo', 3) })
        },
        { metaViz: 'assignees' },
      )
      await board.render(root)
      await repaint()
      // loading: plain squares and a "Loading…" lane, never Unassigned
      expect(portraits(GINA).length).toBeGreaterThan(0)
      expect(portraits(GINA).every((s) => s === 'loading')).toBe(true)
      const lanes = () =>
        [...document.querySelectorAll<HTMLElement>('[data-lane^="assignee:"]')].map((lane) =>
          lane.textContent?.trim(),
        )
      expect(lanes().some((text) => text?.startsWith('Loading…'))).toBe(true)
      for (const words of WORDS_BEFORE_ANSWER)
        expect(document.body.textContent).not.toContain(words)
      expect(document.querySelector(`[data-lane="assignee:unassigned"]`)).toBeNull()
      expect(names.unnamed()).toEqual([])
      // a text filter cannot tell whether a word is in a name not loaded
      // yet, so it keeps the task
      const task = () => {
        const it = board.P.viewTask('board:desktop', 'g1')
        if (!it) throw new Error('the Board holds no g1')
        return it
      }
      expect(board.P.matchesSearch(task(), 'zzz')).toBe(true)
      // the answer names them
      board.server.people.hold = false
      await board.answer()
      await repaint()
      expect(portraits(GINA).every((s) => s === 'ok')).toBe(true)
      expect(document.body.textContent).toContain('Gina Ghost')
      expect(names.unnamed()).toEqual([])
      // once named, the filter decides by the name
      expect(board.P.matchesSearch(task(), 'zzz')).toBe(false)
      expect(board.P.matchesSearch(task(), 'ghost')).toBe(true)
      // only an answer that leaves Hal out makes him unknown
      board.server.people.force = 'gone'
      await board.answer()
      await repaint()
      expect(portraits(HAL).every((s) => s === 'gone')).toBe(true)
      expect(lanes().some((text) => text?.startsWith('Unknown user'))).toBe(true)
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'names the Overview’s lead and its lists’ owners, loading and then by name',
    async () => {
      const { board, names } = await load(
        (snap) => {
          snap.projects[0].lead_id = GINA
          snap.issues.push({
            ...taskRow(snap, 'late', 'progress', 1),
            assignee_id: HAL,
            due_date: '2020-01-01',
          })
        },
        { scope: '' },
      )
      const { Overview } = await import('./views/Overview')
      const actions = new Proxy({}, { get: () => () => {} }) as never
      const scope = board.snapshot.projects[0].id
      await board.renderView(root, (info) => (
        <Overview info={{ ...info, ...(board.P.scopeInfo(scope) ?? info) }} actions={actions} />
      ))
      await repaint()
      const lead = () => document.querySelector('[data-ov-lead]')
      expect(lead()?.textContent).toContain('Loading…')
      expect(names.unnamed()).toEqual([])
      board.server.people.hold = false
      await board.answer()
      await repaint()
      expect(lead()?.textContent).toContain('Gina Ghost')
      expect(names.unnamed()).toEqual([])
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'names the task window’s reporter, holders and its relation rows’ owners, loading and then by name',
    async () => {
      const { board, names } = await load(
        (snap) => {
          snap.issues.push({
            ...taskRow(snap, 'parent', 'progress', 1),
            assignee_id: GINA,
            reporter_id: HAL,
          })
          snap.issues.push({
            ...taskRow(snap, 'child', 'todo', 2),
            parent_id: 'parent',
            assignee_id: HAL,
          })
        },
        { tasks: true },
      )
      const { IssueDetail } = await import('./panels/IssueDetail')
      const handle = board.P.handleOf('parent') ?? ''
      await board.renderView(root, () => (
        <IssueDetail issueId={handle} onClose={() => {}} onOpen={() => {}} />
      ))
      await repaint()
      const reporter = () => document.querySelector('[data-task-reporter]')?.textContent ?? ''
      expect(reporter()).toContain('Loading…')
      expect(reporter()).not.toContain('No reporter')
      expect(names.unnamed()).toEqual([])
      board.server.people.hold = false
      await board.answer()
      await repaint()
      expect(reporter()).toContain('Hal Hidden')
      expect(names.unnamed()).toEqual([])
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'names Team sync’s people and its cards’ owners',
    async () => {
      const { board, names } = await load((snap) => {
        snap.issues.push({ ...taskRow(snap, 'g1', 'progress', 1), assignee_id: GINA })
      }, {})
      const { TeamSync } = await import('./views/TeamSync')
      const scope = `project:${board.snapshot.projects[0].parent_id ?? board.snapshot.projects[0].id}`
      await board.renderView(root, () => (
        <TeamSync
          place={{ scope, step: 'team' }}
          onPlace={() => {}}
          onCorrect={() => {}}
          onClose={() => {}}
          onOpenTask={() => {}}
          onShowTask={() => {}}
          onShowPerson={() => {}}
          onShowBoard={() => {}}
        />
      ))
      await repaint()
      // the page shows Gina's portrait in its walk, named while it shows
      expect(portraits(GINA).length).toBeGreaterThan(0)
      expect(names.unnamed()).toEqual([])
      board.server.people.hold = false
      await board.answer()
      await repaint()
      expect(portraits(GINA).every((s) => s === 'ok')).toBe(true)
      expect(names.unnamed()).toEqual([])
    },
    BOARD_TEST_TIMEOUT,
  )
})
