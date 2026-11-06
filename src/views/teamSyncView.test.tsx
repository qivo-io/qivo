// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgendaAnswer } from '../../convex/lib/teamSyncAgenda'
import type { UnsentScope } from '../lib/leaveGuard'
import { ownerLoadsStandIn } from '../store/ownerLoadsStandIn.setup'
import type { Snapshot } from '../store/plannerFixture.setup'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'
import type { SyncPlace } from './TeamSync'

/* Team sync from the server's agenda (views/TeamSync.tsx,
   views/teamSync/useSyncMeeting.ts) on the real store, not asked, as
   production boots: its read through the store (P.watchSync), answered by
   the agenda's stand-in over the fixture's workspace
   (store/teamSyncStandIn.setup.ts). Every state with its note,
   data-sync-state and aria-busy; the picker, never a fallback to All
   projects; a card only the agenda brings, its banner, its blockers, its
   edits and the chips moving at once, its window and its jumps; the
   opening's unknown figures; a meeting that stops fitting, kept with its
   cards' unsent text; a hidden page; an organization Viewer's people from
   the owner-load cache; and the design size's single figures. */

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
  // jsdom lays nothing out: each step opens at its top by a scroll
  Element.prototype.scrollTo = () => {}
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
  document.body.innerHTML = ''
  Reflect.deleteProperty(document, 'visibilityState')
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const AISHA = 'aisha'

/** The fixture with Aisha, a second person who may see the project, and
    tasks `rows` in its one sub-project, numbered from 1, for the
    fixture's person and In Progress, so their cards show on the person's
    page, unless a row says otherwise. */
const people =
  (...rows: Partial<Snapshot['issues'][number]>[]) =>
  (snap: Snapshot) => {
    const me = snap.profiles[0]
    snap.profiles.push({ ...me, id: AISHA, name: 'Aisha Rahman', auth_user_id: 'account-aisha' })
    rows.forEach((over, i) => {
      snap.issues.push({ ...taskRow(snap, `t${i + 1}`, 'progress', i + 1), ...over })
    })
  }

/* What the page's callbacks received. */
type Calls = {
  places: { next: SyncPlace; closes?: UnsentScope[] }[]
  opened: string[]
  shown: [string, string][]
  boards: string[]
}

/** Loads the store with `prepare` and renders Team sync at `place`, which
    the page moves as App does. */
async function open(
  prepare: (snap: Snapshot) => void,
  place: (snap: Snapshot) => SyncPlace,
  options: Parameters<typeof loadBoard>[2] = {},
  setup: (board: Awaited<ReturnType<typeof loadBoard>>) => void = () => {},
) {
  const board = await loadBoard(network, prepare, options)
  setup(board)
  const { TeamSync } = await import('./TeamSync')
  const calls: Calls = { places: [], opened: [], shown: [], boards: [] }
  const first = place(board.snapshot)
  function Page() {
    const [at, setAt] = useState(first)
    return (
      <TeamSync
        place={at}
        onPlace={(next, closes) => {
          calls.places.push({ next, closes })
          setAt(next)
        }}
        onCorrect={setAt}
        onClose={() => {}}
        onOpenTask={(target) => calls.opened.push(target)}
        onShowTask={(view, handle) => calls.shown.push([view, handle])}
        onShowPerson={() => {}}
        onShowBoard={(id) => calls.boards.push(id)}
      />
    )
  }
  await board.renderView(root, () => <Page />)
  await settle()
  return { board, calls, P: board.P, snapshot: board.snapshot }
}

/** A few turns for the store's paint timer and React. */
async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}

const page = () => document.querySelector<HTMLElement>('[data-sync-page]')
const state = () => page()?.dataset.syncState
const title = () => document.querySelector('[data-empty-state-title]')?.textContent ?? ''
const card = (handle: string) => document.querySelector<HTMLElement>(`[data-sync-card="${handle}"]`)
const click = (element: Element | null | undefined) =>
  act(async () => (element as HTMLElement | null)?.click())
const me = (snap: Snapshot) => snap.profiles[0].id
const sub = (snap: Snapshot) => snap.projects[0].id
const meta = (snap: Snapshot) => snap.projects[0].parent_id ?? ''
const asked = (board: Awaited<ReturnType<typeof loadBoard>>) =>
  board.server.sync.asked.map((args) => args.scope)

/** The hover text of control `element`, which its tooltip shows. */
async function hintOf(element: Element | null | undefined) {
  const trigger = element?.closest<HTMLElement>('[data-tooltip-trigger]')
  if (!trigger) return null
  const pointer = (type: string) =>
    Object.assign(new MouseEvent(type, { bubbles: true }), { pointerType: 'mouse' })
  await act(async () => {
    trigger.dispatchEvent(pointer('pointermove'))
    await new Promise((resolve) => setTimeout(resolve, 400))
  })
  const tip = document.querySelector('[data-slot="tooltip-content"]')
  const text = tip?.firstChild?.textContent ?? null
  await act(async () => trigger.dispatchEvent(pointer('pointerleave')))
  return text
}

/** Sets the page's visibility, as the browser does when a tab hides. */
async function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
}

/** Writes `text` into card `handle`'s @ window, which it opens. */
async function mention(handle: string, text: string) {
  await click(document.querySelector(`[data-sync-mention="${handle}"]`))
  const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note"]')
  if (!field) throw new Error('missing the note')
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setValue?.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return field
}

/** Types `text` into input `box` through an input event, as a person
    does, which takes the unsaved lease (lib/leaveGuard.ts). */
async function typeInto(box: HTMLInputElement | null | undefined, text: string) {
  if (!box) throw new Error('missing the box')
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    box.focus()
    setValue?.call(box, text)
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Whether some write since the `from`th the network saw sent Remaining
    `hours`. The network's calls run on from case to case. */
const sentRemaining = (hours: number, from = 0) =>
  network.mutation.mock.calls
    .slice(from)
    .some(
      ([, args]) =>
        (args as { patch?: { remaining_hours?: number } }).patch?.remaining_hours === hours,
    )

/** Edits the stand-in's answers: each row's `over` by number. */
const rowsEdit =
  (over: Record<number, Partial<Extract<AgendaAnswer, { state: 'ok' }>['rows'][number]>>) =>
  (answer: AgendaAnswer): AgendaAnswer =>
    answer.state !== 'ok'
      ? answer
      : { ...answer, rows: answer.rows.map((r) => ({ ...r, ...over[r.num] })) }

describe('the picker', () => {
  it(
    'asks to choose with nothing saved, offering the person’s teams and All projects, and reads All projects only on a press',
    async () => {
      const { board, calls } = await open(
        (snap) => {
          people({})(snap)
          snap.teams.push({
            id: 'team-1',
            org_id: snap.orgs[0].id,
            name: 'Platform',
            created_at: '2026-09-01T00:00:00.000Z',
          } as Snapshot['teams'][number])
          snap.teamMembers.push({
            team_id: 'team-1',
            profile_id: snap.profiles[0].id,
            is_leader: false,
          })
        },
        () => ({ scope: '', step: 'team' }),
      )
      expect(state()).toBe('choose')
      expect(title()).toBe('Choose what this meeting covers')
      // nothing was asked, and certainly not All projects
      expect(asked(board)).toEqual([])
      const choices = [...document.querySelectorAll<HTMLElement>('[data-sync-choice]')].map(
        (c) => c.dataset.syncChoice,
      )
      expect(choices).toEqual(['team:team-1', 'all'])
      expect(document.querySelector('[data-sync-scope]')?.textContent).toContain('Choose a scope')
      // the rail is empty until a meeting shows
      expect(document.querySelectorAll('[data-sync-jump]')).toHaveLength(0)
      await click(document.querySelector('[data-sync-choice="all"]'))
      await settle()
      expect(calls.places.at(-1)?.next.scope).toBe('all')
      expect(asked(board)).toEqual([{ kind: 'all' }])
      expect(state()).toBe('ok')
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'asks to choose for a saved team the server refuses, and for an address it cannot resolve, without changing the scope',
    async () => {
      const { board, calls } = await open(people({}), () => ({ scope: 'team:gone', step: 'team' }))
      expect(state()).toBe('unavailable')
      expect(title()).toBe('This team or project is not available')
      expect(document.querySelector('[data-sync-scope]')?.textContent).toContain('Choose a scope')
      // the refused scope is never read as All projects
      expect(asked(board)).toEqual([{ kind: 'team', team_id: 'gone' }])
      expect(calls.places).toEqual([])
      await act(async () => root.unmount())
      root = createRoot(container)
      const again = await open(people({}), () => ({ scope: 'unresolved:99', step: 'team' }))
      expect(state()).toBe('choose')
      expect(title()).toBe('This team or project is not available')
      expect(asked(again.board)).toEqual([])
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'says the access check sentence an unavailable answer carries',
    async () => {
      await open(
        people({}),
        (snap) => ({ scope: `project:${meta(snap)}`, step: 'team' }),
        {},
        (b) => {
          b.server.sync.force = { state: 'access_unchecked' }
        },
      )
      expect(state()).toBe('unavailable')
      expect(document.body.textContent).toContain(
        'Qivo could not check all of your access in time.',
      )
    },
    BOARD_TEST_TIMEOUT,
  )
})

describe('the notes', () => {
  it(
    'shows the loading frame, then the meeting',
    async () => {
      const { board } = await open(
        people({}),
        (snap) => ({ scope: `project:${meta(snap)}`, step: 'team' }),
        {},
        (b) => {
          b.server.sync.hold = true
        },
      )
      expect(state()).toBe('loading')
      expect(page()?.getAttribute('aria-busy')).toBe('true')
      expect(title()).toBe('Loading the meeting…')
      board.server.sync.hold = false
      await board.answer()
      await settle()
      expect(state()).toBe('ok')
      expect(page()?.hasAttribute('aria-busy')).toBe(false)
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'says the meeting is past its limits, offering the smaller scopes, and never shows part of it',
    async () => {
      const { board } = await open(
        people({}),
        (snap) => ({ scope: `project:${meta(snap)}`, step: 'team' }),
        {},
        (b) => {
          b.server.sync.force = { state: 'over_ceiling' }
        },
      )
      expect(state()).toBe('over_ceiling')
      expect(title()).toBe("This selection exceeds Team sync's 1,000-task limit.")
      expect(document.body.textContent).toContain('Choose a smaller team or project.')
      expect(
        document.querySelector(`[data-sync-choice="project:${sub(board.snapshot)}"]`),
      ).not.toBeNull()
      expect(document.querySelector('[data-sync-card]')).toBeNull()
      board.server.sync.force = { state: 'over_budget' }
      await board.answer()
      await settle()
      expect(state()).toBe('over_budget')
      expect(title()).toBe("This selection could not be loaded within Team sync's limits.")
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'points a sub-project past its limits to its Board',
    async () => {
      const { calls, snapshot } = await open(
        people({}),
        (snap) => ({ scope: `project:${sub(snap)}`, step: 'team' }),
        {},
        (b) => {
          b.server.sync.force = { state: 'over_budget' }
        },
      )
      expect(document.body.textContent).toContain('Team sync cannot show this sub-project.')
      const button = [...document.querySelectorAll('button')].find(
        (b) => b.textContent === 'Show it on the Board',
      )
      await click(button)
      expect(calls.boards).toEqual([sub(snapshot)])
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'shows a meeting some of whose tasks have no model without its counts, and STALL.ms later under a note that says so',
    async () => {
      const { board, P } = await open(people({ due_date: '2001-01-01' }, {}), (snap) => ({
        scope: `project:${meta(snap)}`,
        step: 'team',
      }))
      expect(state()).toBe('ok')
      expect(document.querySelectorAll('[data-sync-fact="waiting"]')).toHaveLength(0)
      expect(document.querySelector('[data-sync-progress]')?.textContent).toContain('of 2 tasks')
      const { STALL } = await import('../store/liveParts')
      const stall = STALL.ms
      STALL.ms = 40
      // the answer names t2, which has no model to show
      const syncTask = P.syncTask
      const gone = vi
        .spyOn(P, 'syncTask')
        .mockImplementation((uuid) => (uuid === 't2' ? undefined : syncTask(uuid)))
      try {
        await board.answer()
        await settle()
        expect(state()).toBe('loading')
        expect(page()?.getAttribute('aria-busy')).toBe('true')
        // the meeting it has shows, with no count that would read as whole
        expect(document.querySelector('[data-sync-opening]')).not.toBeNull()
        expect(document.querySelectorAll('[data-sync-fact="waiting"]')).toHaveLength(5)
        expect(document.querySelector('[data-sync-facts]')?.textContent).not.toContain('Overdue1')
        expect(document.querySelector('[data-sync-progress]')?.textContent).toBe('')
        expect(document.querySelector('[data-sync-incomplete]')).toBeNull()
        await act(async () => await new Promise((r) => setTimeout(r, 100)))
        expect(state()).toBe('incomplete')
        expect(page()?.hasAttribute('aria-busy')).toBe(false)
        const note = document.querySelector('[data-sync-incomplete]')
        expect(note?.textContent).toContain(
          "Some of this meeting's tasks have not reached the page",
        )
        expect(document.querySelectorAll('[data-sync-fact="waiting"]')).toHaveLength(5)
        expect(document.querySelector('[data-sync-sentence]')?.textContent).not.toContain(
          'No task is overdue',
        )
        // Try again asks once more, and once every task has a model the
        // note and the counts' wait end
        gone.mockRestore()
        const before = board.server.sync.asked.length
        await click(
          [...(note?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Try again'),
        )
        await settle()
        expect(board.server.sync.asked.length).toBeGreaterThan(before)
        expect(state()).toBe('ok')
        expect(document.querySelector('[data-sync-incomplete]')).toBeNull()
        expect(document.querySelector('[data-sync-facts]')?.textContent).toContain('Overdue1')
      } finally {
        gone.mockRestore()
        STALL.ms = stall
      }
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'says it could not load, with Try again, which asks once more',
    async () => {
      const { board } = await open(
        people({}),
        (snap) => ({ scope: `project:${meta(snap)}`, step: 'team' }),
        {},
        (b) => {
          b.server.sync.fail = new Error('down')
        },
      )
      expect(state()).toBe('error')
      expect(title()).toBe('Team sync could not be loaded')
      board.server.sync.fail = undefined
      const before = board.server.sync.asked.length
      await click(
        [...document.querySelectorAll('button')].find((b) => b.textContent === 'Try again'),
      )
      await settle()
      expect(board.server.sync.asked.length).toBeGreaterThan(before)
      expect(state()).toBe('ok')
    },
    BOARD_TEST_TIMEOUT,
  )
})

describe('a card only the agenda brings', () => {
  it(
    'shows its banner and blockers from the agenda, and opens and jumps by what the store passes on',
    async () => {
      const { P, calls, board } = await open(
        people({}, {}, {}, { status: 'progress' }),
        (snap) => ({ scope: `project:${meta(snap)}`, step: me(snap) }),
        {},
        (b) => {
          b.server.sync.edit = rowsEdit({
            1: { delay: 'late', blocked_by: ['QN-4'] },
            2: { delay: 'behind' },
            3: { delay: 'unknown' },
          })
        },
      )
      expect(state()).toBe('ok')
      // the workspace holds no task: every card is a model of the answer's row
      expect(P.tasksHeld()).toBe(false)
      const handle = (n: number) => P.syncTask(`t${n}`)?.id ?? ''
      expect(card(handle(1))?.querySelector('[data-delay]')?.getAttribute('data-delay')).toBe(
        'late',
      )
      expect(card(handle(2))?.querySelector('[data-delay]')?.getAttribute('data-delay')).toBe(
        'behind',
      )
      expect(card(handle(3))?.querySelector('[data-delay]')?.getAttribute('data-delay')).toBe(
        'unknown',
      )
      expect(card(handle(4))?.querySelector('[data-delay]')).toBeNull()
      expect(card(handle(1))?.querySelector('[data-sync-blocked]')?.textContent).toContain('QN-4')
      // the window opens through the window's own read, by reference
      await click(card(handle(1))?.querySelector(`[data-sync-open="${handle(1)}"]`))
      expect(calls.opened).toEqual([P.openTarget(handle(1))])
      expect(calls.opened[0]).not.toBe(handle(1))
      await click(card(handle(1))?.querySelector(`[data-sync-board="${handle(1)}"]`))
      expect(calls.shown).toEqual([['kanban', handle(1)]])
      // the blocker moved to Done here stops blocking at once
      void P.updateIssue(handle(4), { status: 'done' })
      await settle()
      expect(card(handle(1))?.querySelector('[data-sync-blocked]')).toBeNull()
      expect(board.server.sync.asked.every((a) => a.scope.kind === 'project')).toBe(true)
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'moves between sections and moves the chip at once on its own edits',
    async () => {
      // the Monday that begins this week on the fixture's grid
      const d = new Date()
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
      const pad = (n: number) => String(n).padStart(2, '0')
      const monday = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      const { P } = await open(
        people(
          { start_week: monday, end_week: monday, remaining_hours: 8 },
          { status: 'progress' },
        ),
        (snap) => ({ scope: `project:${meta(snap)}`, step: me(snap) }),
      )
      const handle = (n: number) => P.syncTask(`t${n}`)?.id ?? ''
      const chip = () => document.querySelector('[data-sync-person] [data-sync-load]')?.textContent
      expect(chip()).toContain('25%')
      // a Remaining typed on the card writes at once and moves the chip
      const box = card(handle(1))?.querySelector<HTMLInputElement>('[data-sync-input]')
      await act(async () => {
        box?.focus()
        if (box) box.value = '12'
        box?.blur()
      })
      await settle()
      expect(
        network.mutation.mock.calls.some(
          ([, args]) =>
            (args as { patch?: { remaining_hours?: number } }).patch?.remaining_hours === 12,
        ),
      ).toBe(true)
      expect(chip()).toContain('38%')
      // a move to Done shows it in Done since at once
      void P.updateIssue(handle(2), { status: 'done' })
      await settle()
      const done = document.querySelector('[data-sync-col="done"]')
      expect(done?.querySelector(`[data-sync-done-row="${handle(2)}"]`)).not.toBeNull()
      // a Pause marks it paused and takes its hours out at once
      void P.updateIssue(handle(1), { paused: true })
      await settle()
      expect(P.syncTask('t1')?.paused).toBe(true)
      expect(chip()).toContain('0%')
      // given to someone outside the walk, it leaves this page at once
      void P.updateIssue(handle(1), { assignee: AISHA })
      await settle()
      expect(card(handle(1))).toBeNull()
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'posts a mention to its organization',
    async () => {
      const { P, snapshot } = await open(people({}), (snap) => ({
        scope: `project:${meta(snap)}`,
        step: me(snap),
      }))
      const handle = P.syncTask('t1')?.id ?? ''
      await mention(handle, 'Can you check it?')
      await click(document.querySelector(`[data-sync-mention-person="${AISHA}"]`))
      await click(document.querySelector('[data-sync-mention-send]'))
      // the comment names the task and the organization of the agenda's row,
      // which the workspace does not hold
      const sent = network.mutation.mock.calls.find(
        ([ref]) => getFunctionName(ref) === 'comments:create',
      )
      expect(sent?.[1]).toMatchObject({ issue_id: 't1', org_id: snapshot.orgs[0].id })
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'draws no banner for a held task the agenda finds on track, whatever the workspace says',
    async () => {
      const { P } = await open(
        (snap) => {
          snap.projects[0].track_delay = true
          people({ due_date: '2001-01-01' })(snap)
        },
        (snap) => ({ scope: `project:${meta(snap)}`, step: me(snap) }),
        { tasks: true },
        (b) => {
          b.server.sync.edit = rowsEdit({ 1: { delay: null } })
        },
      )
      const handle = P.handleOf('t1') ?? ''
      expect(handle).not.toBe('')
      // the workspace holds the task and judges it late, past its due date
      expect(P.delayOf(P.issueById[handle])?.status).toBe('late')
      expect(card(handle)).not.toBeNull()
      expect(card(handle)?.querySelector('[data-delay]')).toBeNull()
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'shows no row the answer does not name',
    async () => {
      await open(
        people({}, {}),
        (snap) => ({ scope: `project:${meta(snap)}`, step: me(snap) }),
        {},
        (b) => {
          b.server.sync.edit = (answer) =>
            answer.state === 'ok'
              ? { ...answer, rows: answer.rows.filter((r) => r.num !== 2) }
              : answer
        },
      )
      const cards = [...document.querySelectorAll<HTMLElement>('[data-sync-card]')]
      expect(cards).toHaveLength(1)
    },
    BOARD_TEST_TIMEOUT,
  )
})

describe("a person's page and the agents'", () => {
  it(
    "reads Done since from the agenda's stamp, not the people part's",
    async () => {
      const finished = new Date(Date.now() - 2 * 3_600_000).toISOString()
      const { board } = await open(people({ status: 'done', done_at: finished }, {}), (snap) => ({
        scope: `project:${meta(snap)}`,
        step: me(snap),
      }))
      const done = () => document.querySelectorAll('[data-sync-col="done"] [data-sync-done-row]')
      // no stamp: read from the working day before today, which holds it
      expect(done()).toHaveLength(1)
      // the agenda's stamp of a sitting that ended after it: the page reads
      // from it, while the people part still has no stamp
      // a sitting under way since half an hour, reading from an hour ago
      const at = new Date(Date.now() - 1_800_000).toISOString()
      const since = new Date(Date.now() - 3_600_000).toISOString()
      const old = new Date(Date.now() - 50 * 3_600_000).toISOString()
      board.server.sync.edit = (answer) =>
        answer.state === 'ok'
          ? {
              ...answer,
              people: answer.people.map((p) => ({ ...p, stamp: { at: old, since: undefined } })),
            }
          : answer
      await board.answer()
      await settle()
      // the sitting is over, so the reading point is the stamp itself, which
      // still holds the task; a sitting that reads from after the task takes
      // it out
      expect(done()).toHaveLength(1)
      board.server.sync.edit = (answer) =>
        answer.state === 'ok'
          ? {
              ...answer,
              people: answer.people.map((p) => ({ ...p, stamp: { at, since } })),
            }
          : answer
      await board.answer()
      await settle()
      expect(board.P.user(board.snapshot.profiles[0].id)?.sync ?? null).toBeNull()
      expect(done()).toHaveLength(0)
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    "says an agent's delays are unknown rather than count them",
    async () => {
      const ATLAS = 'atlas'
      const { P } = await open(
        (snap) => {
          snap.profiles.push({
            ...snap.profiles[0],
            id: ATLAS,
            name: 'Atlas',
            kind: 'agent',
            auth_user_id: undefined,
          })
          people({ assignee_id: ATLAS }, { assignee_id: ATLAS })(snap)
        },
        (snap) => ({ scope: `project:${meta(snap)}`, step: 'agents' }),
        {},
        (b) => {
          b.server.sync.edit = rowsEdit({ 1: { delay: 'late' }, 2: { delay: 'unknown' } })
        },
      )
      expect(P.syncRead().value?.state).toBe('ok')
      const line = document.querySelector(`[data-sync-agent="${ATLAS}"]`)
      expect(line?.querySelector('[data-sync-agent-delays="unknown"]')?.textContent).toBe(
        'Delays unknown',
      )
      // a count that left the unknown row out would read as whole
      expect(line?.textContent).not.toContain('1 Delayed')
    },
    BOARD_TEST_TIMEOUT,
  )
})

describe('the opening', () => {
  it(
    'reads Projected to miss and Slipping unknown where a verdict is, and the capacity list says whose load is unknown, never 0',
    async () => {
      await open(
        people({ due_date: '2001-01-01' }, {}),
        (snap) => ({ scope: `project:${meta(snap)}`, step: 'team' }),
        {},
        (b) => {
          b.server.sync.force = { weeks: 'loads' }
          b.server.sync.edit = rowsEdit({ 2: { delay: 'unknown' } })
        },
      )
      const facts = document.querySelector('[data-sync-facts]')
      expect(facts?.querySelectorAll('[data-sync-fact="unknown"]')).toHaveLength(2)
      // the stored facts keep their counts
      expect(facts?.textContent).toContain('Overdue1')
      expect(document.querySelector('[data-sync-sentence]')?.textContent).toContain(
        'Qivo could not work out every projected delay.',
      )
      expect(document.querySelector('[data-sync-capacity-unknown]')?.textContent).toBe(
        'Load unknown for 1 person',
      )
      // the heading counts no list that leaves someone out, as a 0 there
      // would read as whole
      const heading = [...document.querySelectorAll('h3')].find((h) =>
        h.textContent?.startsWith('Near or over capacity'),
      )
      expect(heading).toBeDefined()
      expect(heading?.querySelector('span')).toBeNull()
      expect(document.body.textContent).not.toContain('Everyone is under 90% this week')
      expect(document.body.textContent).not.toContain('0%')
    },
    BOARD_TEST_TIMEOUT,
  )
})

describe('a meeting that stops fitting', () => {
  it(
    'keeps the last meeting under the note, its cards’ unsent note and read-only controls, and ends with the next ok answer',
    async () => {
      const { board, P, calls } = await open(people({}), (snap) => ({
        scope: `project:${meta(snap)}`,
        step: me(snap),
      }))
      const handle = P.syncTask('t1')?.id ?? ''
      const field = await mention(handle, 'Still typing')
      board.server.sync.force = { state: 'over_ceiling' }
      await board.answer()
      await settle()
      expect(state()).toBe('stale')
      expect(page()?.hasAttribute('data-sync-stale')).toBe(true)
      expect(
        document.querySelector('[data-sync-stale-note="over_ceiling"]')?.textContent,
      ).toContain('stopped updating at')
      // the card and its note stay, the task controls are off, the mention sends
      expect(card(handle)).not.toBeNull()
      expect(field.isConnected).toBe(true)
      expect(field.value).toBe('Still typing')
      const box = card(handle)?.querySelector<HTMLInputElement>('[data-sync-input]')
      expect(box?.readOnly).toBe(true)
      expect(await hintOf(box)).toBe(
        'This meeting stopped updating. Choose a smaller team or project.',
      )
      await click(document.querySelector(`[data-sync-mention-person="${AISHA}"]`))
      expect(document.querySelector<HTMLButtonElement>('[data-sync-mention-send]')?.disabled).toBe(
        false,
      )
      // a narrower scope from the note asks about the card's unsent note
      await click(document.querySelector(`[data-sync-choice="project:${sub(board.snapshot)}"]`))
      expect(calls.places.at(-1)?.closes?.length).toBeGreaterThan(0)
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'turns the opening’s owner and reviewer pickers off too, as the cards’',
    async () => {
      const { board, P } = await open(
        people(
          { status: 'review', reviewer_id: undefined },
          // open, urgent and unowned, so Needs an owner lists it
          { status: 'todo', assignee_id: undefined, priority: 'urgent' },
        ),
        (snap) => ({ scope: `project:${meta(snap)}`, step: 'team' }),
      )
      const trigger = (hook: string, n: number) =>
        document.querySelector<HTMLButtonElement>(
          `[${hook}="${P.syncTask(`t${n}`)?.id ?? ''}"] [data-assignee-edit]`,
        )
      expect(trigger('data-sync-needs-reviewer', 1)?.disabled).toBe(false)
      expect(trigger('data-sync-needs-owner', 2)?.disabled).toBe(false)
      board.server.sync.force = { state: 'over_budget' }
      await board.answer()
      await settle()
      expect(state()).toBe('stale')
      for (const [hook, n] of [
        ['data-sync-needs-reviewer', 1],
        ['data-sync-needs-owner', 2],
      ] as const) {
        expect(trigger(hook, n)?.disabled, hook).toBe(true)
        expect(await hintOf(trigger(hook, n)), hook).toBe(
          'This meeting stopped updating. Choose a smaller team or project.',
        )
      }
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'says it stopped updating when the tab hid, not when the refusal arrived on return',
    async () => {
      const { board } = await open(people({}), (snap) => ({
        scope: `project:${meta(snap)}`,
        step: me(snap),
      }))
      expect(state()).toBe('ok')
      // the same local day throughout, so the meeting's day does not move
      const at = (hours: number) => {
        const d = new Date()
        d.setHours(hours, 0, 0, 0)
        return d
      }
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(at(9))
      await setVisibility('hidden')
      await settle()
      expect(board.server.sync.open.size).toBe(0)
      vi.setSystemTime(at(15))
      board.server.sync.force = { state: 'over_ceiling' }
      await setVisibility('visible')
      await settle()
      expect(state()).toBe('stale')
      const note = document.querySelector('[data-sync-stale-note="over_ceiling"]')?.textContent
      expect(note).toContain('The meeting below stopped updating at 09:00.')
      // the time the refusal arrived would say the cards are newer than they are
      expect(note).not.toContain('15:00')
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'keeps the meeting under a failure after ok, with Try again',
    async () => {
      const { board, P } = await open(people({}), (snap) => ({
        scope: `project:${meta(snap)}`,
        step: me(snap),
      }))
      const handle = P.syncTask('t1')?.id ?? ''
      // hours typed into the box as the meeting stops updating stay typed
      const box = () => card(handle)?.querySelector<HTMLInputElement>('[data-sync-input]')
      await act(async () => {
        box()?.focus()
        const typed = box()
        if (typed) typed.value = '9'
      })
      board.server.sync.fail = new Error('down')
      await board.answer()
      await settle()
      expect(state()).toBe('stale')
      expect(document.querySelector('[data-sync-stale-note="error"]')).not.toBeNull()
      expect(card(handle)).not.toBeNull()
      // a blur in the stale box writes nothing and keeps the hours typed,
      // and its title points to the note's Try again, not a smaller scope
      const sent = network.mutation.mock.calls.length
      expect(box()?.readOnly).toBe(true)
      expect(await hintOf(box())).toBe(
        'This meeting stopped updating. Try again from the note above.',
      )
      await act(async () => box()?.blur())
      await settle()
      expect(network.mutation.mock.calls.length).toBe(sent)
      expect(box()?.value).toBe('9')
      board.server.sync.fail = undefined
      await board.answer()
      await settle()
      expect(state()).toBe('ok')
      // the next ok answer makes the box write again, the typed hours with it
      expect(box()?.value).toBe('9')
      await act(async () => {
        box()?.focus()
        box()?.blur()
      })
      await settle()
      expect(sentRemaining(9)).toBe(true)
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'keeps the leave guard on hours typed into a box the meeting froze, through a blur that sends nothing',
    async () => {
      const { board, P } = await open(people({}), (snap) => ({
        scope: `project:${meta(snap)}`,
        step: me(snap),
      }))
      const { hasUnsaved } = await import('../lib/leaveGuard')
      const handle = P.syncTask('t1')?.id ?? ''
      const box = () => card(handle)?.querySelector<HTMLInputElement>('[data-sync-input]')
      expect(hasUnsaved()).toBe(false)
      await typeInto(box(), '9')
      expect(hasUnsaved()).toBe(true)
      board.server.sync.force = { state: 'over_ceiling' }
      await board.answer()
      await settle()
      expect(state()).toBe('stale')
      expect(box()?.readOnly).toBe(true)
      const from = network.mutation.mock.calls.length
      await act(async () => box()?.blur())
      await settle()
      // the blur sent nothing, so the typed hours keep their lease and a
      // scope change, a close or a reload still asks first
      expect(sentRemaining(9, from)).toBe(false)
      expect(box()?.value).toBe('9')
      expect(hasUnsaved()).toBe(true)
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'keeps the stale meeting and the hours typed in it through Try again, busy until its answer, and the next ok answer makes the box write again',
    async () => {
      const { board, P } = await open(people({}), (snap) => ({
        scope: `project:${meta(snap)}`,
        step: me(snap),
      }))
      const handle = P.syncTask('t1')?.id ?? ''
      const box = () => card(handle)?.querySelector<HTMLInputElement>('[data-sync-input]')
      await typeInto(box(), '9')
      board.server.sync.fail = new Error('down')
      await board.answer()
      await settle()
      expect(state()).toBe('stale')
      // Try again, whose answer the server holds back
      board.server.sync.fail = undefined
      board.server.sync.hold = true
      const before = board.server.sync.asked.length
      const note = document.querySelector('[data-sync-stale-note="error"]')
      await click(
        [...(note?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Try again'),
      )
      await settle()
      expect(board.server.sync.asked.length).toBeGreaterThan(before)
      // the meeting stays, stale and read-only, busy, with the typed hours
      expect(state()).toBe('stale')
      expect(page()?.getAttribute('aria-busy')).toBe('true')
      expect(card(handle)).not.toBeNull()
      expect(box()?.readOnly).toBe(true)
      expect(box()?.value).toBe('9')
      board.server.sync.hold = false
      await board.answer()
      await settle()
      expect(state()).toBe('ok')
      expect(page()?.hasAttribute('aria-busy')).toBe(false)
      // the ok answer makes the box write again, the typed hours with it
      expect(box()?.readOnly).toBe(false)
      expect(box()?.value).toBe('9')
      const from = network.mutation.mock.calls.length
      await act(async () => {
        box()?.focus()
        box()?.blur()
      })
      await settle()
      expect(sentRemaining(9, from)).toBe(true)
    },
    BOARD_TEST_TIMEOUT,
  )
})

describe('a hidden page', () => {
  it(
    'holds no agenda and no last-comments subscription while the tab is hidden, and shows its meeting as refreshing on return',
    async () => {
      const { board } = await open(people({}), (snap) => ({
        scope: `project:${meta(snap)}`,
        step: me(snap),
      }))
      expect(board.server.sync.open.size).toBe(1)
      expect(board.server.comments.size).toBeGreaterThan(0)
      board.server.sync.hold = true
      await setVisibility('hidden')
      await settle()
      expect(board.server.sync.open.size).toBe(0)
      expect(board.server.comments.size).toBe(0)
      await setVisibility('visible')
      await settle()
      expect(state()).toBe('refreshing')
      expect(page()?.getAttribute('aria-busy')).toBe('true')
      expect(document.querySelector('[data-sync-card]')).not.toBeNull()
      board.server.sync.hold = false
      await board.answer()
      await settle()
      expect(state()).toBe('ok')
    },
    BOARD_TEST_TIMEOUT,
  )
})

describe("an organization Viewer's page", () => {
  it(
    'reads the person on screen through the owner-load cache, with "…" and no mark while it waits, the week and the judged delay once it answers, and unknown when it cannot',
    async () => {
      // 100 hours from this week's Monday, due next week's Friday. Only the
      // owner's load tells that a 40-hour week finishes it late
      const d = new Date()
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
      const pad = (n: number) => String(n).padStart(2, '0')
      const iso = (x: Date) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`
      const monday = iso(d)
      d.setDate(d.getDate() + 11)
      const friday = iso(d)
      // the cache's calls, answered when the test says
      const calls: { args: Parameters<typeof ownerLoadsStandIn>[1]; next: (v: unknown) => void }[] =
        []
      const { board, P } = await open(
        (snap) => {
          snap.profiles[0].org_role = 'viewer'
          snap.projects[0].track_delay = true
          people({
            remaining_hours: 100,
            start_week: monday,
            end_week: monday,
            due_date: friday,
          })(snap)
          snap.access.push({
            project_id: snap.projects[0].id,
            profile_id: snap.profiles[0].id,
            level: 'viewer',
          } as Snapshot['access'][number])
        },
        (snap) => ({ scope: `project:${meta(snap)}`, step: me(snap) }),
        {},
        () => {
          const real = network.onUpdate.getMockImplementation()
          network.onUpdate.mockImplementation((ref, args, next, fail) => {
            if (getFunctionName(ref) !== 'planning:ownerLoads') return real?.(ref, args, next, fail)
            calls.push({ args, next })
            return () => {}
          })
        },
      )
      expect(state()).toBe('ok')
      expect(P.syncRead().value).toMatchObject({ hidden: 'own_only' })
      const answer = P.syncRead().value
      if (answer?.state !== 'ok') throw new Error('no meeting')
      // the agenda reads no load for a Viewer, so it leaves the verdict unknown
      expect(answer.rows[0]?.delay).toBe('unknown')
      const handle = P.syncTask('t1')?.id ?? ''
      const chip = () => document.querySelector('[data-sync-person] [data-sync-load]')
      const banner = () => card(handle)?.querySelector('[data-delay]')
      // one owner a call, while it waits: "…" and no mark, as a Board card
      expect(calls.map((c) => c.args.owner_ids)).toEqual([[me(board.snapshot)]])
      expect(chip()?.getAttribute('data-sync-load')).toBe('waiting')
      expect(chip()?.textContent).toContain('…')
      expect(banner()).toBeNull()
      const answerCalls = (unavailable: string[]) =>
        act(async () => {
          for (const c of calls) c.next(ownerLoadsStandIn(board.snapshot, c.args, { unavailable }))
        })
      await answerCalls([])
      await settle()
      expect(chip()?.getAttribute('data-sync-load')).not.toBe('waiting')
      expect(chip()?.getAttribute('data-sync-load')).not.toBe('unknown')
      expect(chip()?.textContent).not.toContain('unknown')
      expect(banner()?.getAttribute('data-delay')).toBe('late')
      // a load it cannot read says unknown, never 0
      await answerCalls([me(board.snapshot)])
      await settle()
      expect(chip()?.getAttribute('data-sync-load')).toBe('unknown')
      expect(chip()?.textContent).not.toContain('0%')
      expect(banner()?.getAttribute('data-delay')).toBe('unknown')
    },
    BOARD_TEST_TIMEOUT,
  )
})

describe('the design size, one figure at a time', () => {
  it('opens a project of 800 open and 200 Done tasks over 3 sub-projects, its opening and a person page', async () => {
    const { spread } = await import('./boardFixture.setup')
    const done = new Date(Date.now() - 3_600_000).toISOString()
    const { P } = await open(
      (snap) => {
        spread(334, (n) => (n > 800 ? 'done' : 'todo'))(snap)
        for (const it of snap.issues) {
          if (it.status === 'done') it.done_at = done
          // unowned and urgent, so Needs an owner mounts in slices
          if (it.num % 10 === 0) {
            it.assignee_id = undefined
            it.priority = 'urgent'
          }
        }
      },
      () => ({ scope: 'project:plan', step: 'team' }),
    )
    expect(state()).toBe('ok')
    const answer = P.syncRead().value
    if (answer?.state !== 'ok') throw new Error('no meeting')
    expect(answer.rows.length + answer.asks.length + answer.done.length).toBeLessThanOrEqual(1000)
    expect(document.querySelectorAll('[data-sync-needs-owner]').length).toBeGreaterThan(0)
    await click(document.querySelector(`[data-sync-jump="${P.CURRENT_USER}"]`))
    await settle()
    expect(document.querySelector('[data-sync-person]')).not.toBeNull()
  }, 60_000)

  it('shows one person’s page of a sub-project of 300 open and 150 Done tasks', async () => {
    const finished = new Date(Date.now() - 3_600_000).toISOString()
    await open(
      (snap) => {
        for (let n = 1; n <= 450; n++)
          snap.issues.push({
            ...taskRow(snap, `t${n}`, n <= 300 ? 'progress' : 'done', n),
            title: `${'An ordinary task title of about eighty characters, '.repeat(1)}number ${n}`,
            ...(n > 300 ? { done_at: finished } : {}),
          })
      },
      (snap) => ({ scope: `project:${sub(snap)}`, step: me(snap) }),
    )
    expect(state()).toBe('ok')
    expect(document.querySelectorAll('[data-sync-card]')).toHaveLength(300)
    expect(document.querySelectorAll('[data-sync-done-row]')).toHaveLength(150)
  }, 60_000)

  it('shows the rail of a team whose 600 rows 200 of its members own', async () => {
    await open(
      (snap) => {
        const base = snap.projects[0]
        const org = snap.orgs[0].id
        snap.projects.push({ ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 2, name: 'Plan' })
        Object.assign(base, { parent_id: 'plan', name: 'Sub 1' })
        for (let i = 2; i <= 20; i++)
          snap.projects.push({
            ...base,
            id: `sub-${i}`,
            key: `S${i}`,
            num: i + 1,
            name: `Sub ${i}`,
          })
        snap.teams.push({
          id: 'team-1',
          org_id: org,
          name: 'Platform',
          created_at: '2026-09-01T00:00:00.000Z',
        } as Snapshot['teams'][number])
        snap.teamAccess.push({
          project_id: 'plan',
          team_id: 'team-1',
          level: 'user',
        } as Snapshot['teamAccess'][number])
        const members = Array.from({ length: 200 }, (_, i) => `m${i}`)
        for (const id of members) {
          snap.profiles.push({
            ...snap.profiles[0],
            id,
            name: `Member ${id}`,
            org_role: 'user',
            auth_user_id: undefined,
          })
          snap.teamMembers.push({
            team_id: 'team-1',
            profile_id: id,
          } as Snapshot['teamMembers'][number])
        }
        const subs = snap.projects.filter((p) => p.parent_id === 'plan')
        for (let n = 1; n <= 600; n++)
          snap.issues.push({
            ...taskRow(snap, `t${n}`, 'todo', n),
            project_id: subs[(n - 1) % subs.length].id,
            assignee_id: members[(n - 1) % members.length],
          })
      },
      () => ({ scope: 'team:team-1', step: 'team' }),
    )
    expect(state()).toBe('ok')
    expect(document.querySelectorAll('[data-sync-rail] [data-sync-jump]')).toHaveLength(201)
  }, 60_000)
})
