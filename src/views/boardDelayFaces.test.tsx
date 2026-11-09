// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TODAY_WEEK, weekToISO } from '../lib/dates'
import type { Snapshot } from '../store/plannerFixture.setup'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* A Board card's delay waits for its owner's face, whose plannable hours
   it is judged by (store/planner.ts ownerFacts), and is never judged
   against the default week while that face is on its way or could not be
   read. A person the server's answer leaves out is judged against the
   default week. At everyday values: one task of one owner, 30 hours in
   this week, which fits the default 40 hours and not the owner's 10. */

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
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** The owner of the task, a person with a 10-hour week whom the store does
    not hold. */
const OWNER = 'person-0001'

/** A Board whose project tracks delays, with task 't1' of `owner`, 30
    hours left over this week alone, due next week. With `listed`, the
    server's data holds the owner. */
async function ownedBoard(owner: string, listed = true) {
  return loadBoard(network, (snap: Snapshot) => {
    snap.projects[0].track_delay = true
    if (listed)
      snap.profiles.push({
        ...snap.profiles[0],
        id: owner,
        auth_user_id: 'account-0001',
        name: 'Person 0001',
        org_role: 'user',
        plannable_hours: 10,
      })
    snap.issues.push({
      ...taskRow(snap, 't1', 'todo', 1),
      assignee_id: owner,
      start_week: weekToISO(TODAY_WEEK),
      end_week: weekToISO(TODAY_WEEK),
      due_date: weekToISO(TODAY_WEEK + 1),
      remaining_hours: 30,
    })
  })
}

/** The card's model, as the Board's answer shaped it. */
const cardOf = (board: Awaited<ReturnType<typeof ownedBoard>>) => {
  const it = board.P.viewTask('board:desktop', 't1')
  if (!it) throw new Error('no card of t1')
  return it
}

describe("a Board card's delay, judged by its owner's hours", () => {
  it(
    'says nothing until the owner’s face brings their hours, never judging the default week',
    async () => {
      const board = await ownedBoard(OWNER)
      board.server.people.hold = true
      await board.render(root)
      await board.answer()
      // the face is on its way, so no verdict, none against 40 hours and
      // no Delay unknown before the face could tell
      expect(board.P.delayOf(cardOf(board))).toBeNull()
      expect(board.P.delayUnknown(cardOf(board))).toBe(false)
      board.server.people.hold = false
      await board.answerPeople()
      // the face's 10 hours judge it late
      await vi.waitFor(() => expect(board.P.delayOf(cardOf(board))?.status).toBe('late'))
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'says Delay unknown for a card whose owner’s face could not be read, never on track',
    async () => {
      const board = await ownedBoard(OWNER)
      board.server.people.force = 'error'
      await board.render(root)
      await board.answer()
      await vi.waitFor(() => expect(board.P.person(OWNER)?.state).toBe('failed'))
      // no verdict against a default week, and the card says it cannot tell
      await vi.waitFor(() => expect(board.P.delayUnknown(cardOf(board))).toBe(true))
      expect(board.P.delayOf(cardOf(board))).toBeNull()
      expect(board.card('t1')?.textContent).toContain('Delay unknown')
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'judges an owner the server’s answer leaves out against the default week',
    async () => {
      const board = await ownedBoard('person-gone', false)
      await board.render(root)
      await board.answer()
      await vi.waitFor(() => expect(board.P.person('person-gone')?.state).toBe('gone'))
      // 30 of 40 hours fit the week
      await vi.waitFor(() => expect(board.P.delayOf(cardOf(board))?.status).toBe('ok'))
      expect(board.P.delayUnknown(cardOf(board))).toBe(false)
    },
    BOARD_TEST_TIMEOUT,
  )
})
