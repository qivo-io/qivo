// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IssueVM } from '../store/planner'
import { BOARD_TEST_TIMEOUT, cell, dragEvent, loadBoard, taskRow } from './boardFixture.setup'

/** The handle the Board names task `uuid` of the server's data by
    (P.handleNow). */
const handleOf = (
  board: {
    P: { handleNow(uuid: string, org: string, num: number): string }
    snapshot: { issues: { id: string; org_id: string; num: number }[] }
  },
  uuid: string,
) => {
  const row = board.snapshot.issues.find((t) => t.id === uuid)
  return row ? board.P.handleNow(row.id, row.org_id, row.num) : ''
}

/* Dragging a Board card on the real store, into a status and into a
   person's lane, where the write, not the browser, judges the person. */

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
/* The owner's portrait renders once per task row, so it counts card
   renders: a live row's through AssigneeAvatar, a static card's through
   staticOwnerPortrait. */
const portraits = vi.hoisted(() => ({ rendered: [] as string[] }))
vi.mock('@/components/AssigneeAvatar', () => ({
  AssigneeAvatar: ({ issue }: { issue: IssueVM }) => {
    portraits.rendered.push(issue.uuid)
    return null
  },
  OwnerPickList: () => null,
}))
vi.mock('@/components/rowElements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/rowElements')>()),
  staticOwnerPortrait: (_statics: unknown, issue: IssueVM) => {
    portraits.rendered.push(issue.uuid)
    return null
  },
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
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/* A card in To Do and twenty in In Progress. */
const crowded = () =>
  loadBoard(network, (snap) => {
    snap.issues.push(taskRow(snap, 'a', 'todo', 1))
    for (let n = 0; n < 20; n++) snap.issues.push(taskRow(snap, `p${n}`, 'progress', n + 2))
  })
const over = (status: string) => act(async () => cell(status)?.dispatchEvent(dragEvent('dragover')))
const highlighted = (status: string) => !!cell(status)?.style.outline.includes('dashed')

describe('dragging a Board card', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('highlights the cell it is over without rendering any card', async () => {
    const board = await crowded()
    await board.render(root)
    await act(async () => board.card('a')?.dispatchEvent(dragEvent('dragstart')))
    // the counter sees the cards, static ones included
    expect(portraits.rendered).toContain('p19')
    portraits.rendered = []
    await over('progress')
    expect(portraits.rendered).toEqual([])
    expect(highlighted('progress')).toBe(true)
    expect(cell('progress')?.hasAttribute('data-drop-over')).toBe(true)
  })

  it('highlights only the last cell it was over', async () => {
    const board = await crowded()
    await board.render(root)
    await act(async () => board.card('a')?.dispatchEvent(dragEvent('dragstart')))
    await over('progress')
    // no dragleave between them, as a fast drag can deliver it
    await over('review')
    expect(highlighted('progress')).toBe(false)
    expect(highlighted('review')).toBe(true)
    // back over its own cell: no destination, and the source is not one
    await over('todo')
    expect(highlighted('review')).toBe(false)
    expect(highlighted('todo')).toBe(false)
    expect(cell('todo')?.hasAttribute('data-drop-over')).toBe(false)
  })

  it('clears the highlight when the drag drops or ends', async () => {
    const board = await crowded()
    await board.render(root)
    const status = () => board.P.anyTask(handleOf(board, 'a'))?.status
    await act(async () => board.card('a')?.dispatchEvent(dragEvent('dragstart')))
    await over('review')
    await act(async () => board.card('a')?.dispatchEvent(dragEvent('dragend')))
    expect(highlighted('review')).toBe(false)
    expect(status()).toBe('todo')
    await act(async () => board.card('a')?.dispatchEvent(dragEvent('dragstart')))
    await over('progress')
    await act(async () => cell('progress')?.dispatchEvent(dragEvent('drop')))
    expect(status()).toBe('progress')
    expect(highlighted('progress')).toBe(false)
    expect(document.querySelector('[data-drop-over]')).toBeNull()
  })

  it('takes no drop from a drag that did not start on a card', async () => {
    const board = await crowded()
    await board.render(root)
    const status = () => board.P.anyTask(handleOf(board, 'a'))?.status
    // the card's own drag ends where the Board never hears of it
    await act(async () => board.card('a')?.dispatchEvent(dragEvent('dragstart')))
    // a file dragged in from the desktop carries no task
    const file = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', {
        value: { types: ['Files'], dropEffect: 'none', getData: () => '' },
      })
      return event
    }
    const offer = file('dragover')
    await act(async () => cell('review')?.dispatchEvent(offer))
    expect(offer.defaultPrevented).toBe(false)
    expect(highlighted('review')).toBe(false)
    await act(async () => cell('review')?.dispatchEvent(file('drop')))
    expect(status()).toBe('todo')
  })

  it('ends once the dragged card has left the page', async () => {
    const board = await loadBoard(network, (snap) => {
      snap.issues.push(taskRow(snap, 'a', 'todo', 1), taskRow(snap, 'b', 'todo', 2))
    })
    await board.render(root)
    const row = (uuid: string) => board.card(uuid)
    const { isUpdateBlocked } = await import('../lib/updateSafety')
    await act(async () => row('a')?.dispatchEvent(dragEvent('dragstart')))
    expect(isUpdateBlocked()).toBe(true)
    expect(row('a')?.classList.contains('opacity-40')).toBe(true)
    // another person moves the task, which replaces its row in In Progress;
    // dragend then fires on the removed row and never reaches the Board
    board.snapshot.issues.find((issue) => issue.id === 'a')!.status = 'progress'
    await board.deliver()
    expect(cell('progress')?.contains(row('a'))).toBe(true)
    expect(isUpdateBlocked()).toBe(true)
    await act(async () => window.dispatchEvent(new Event('pointermove')))
    expect(isUpdateBlocked()).toBe(false)
    expect(document.querySelector('.opacity-40')).toBeNull()
  })

  /** A Board by person with Vic, an organization Viewer whom the write
      refuses as a new assignee, holding task `v`, and Olle, a user who may
      take work, holding task `o`; the fixture's person holds `a`. Task
      writes wait for `answer`. */
  async function lanesBoard() {
    const board = await loadBoard(
      network,
      (snap) => {
        const me = snap.profiles[0]
        snap.profiles.push(
          { ...me, id: 'vic', name: 'Vic Viewer', auth_user_id: 'account-vic', org_role: 'viewer' },
          { ...me, id: 'olle', name: 'Olle Berg', auth_user_id: 'account-olle', org_role: 'user' },
        )
        snap.issues.push(
          taskRow(snap, 'a', 'todo', 1),
          { ...taskRow(snap, 'v', 'todo', 2), assignee_id: 'vic' },
          { ...taskRow(snap, 'o', 'todo', 3), assignee_id: 'olle' },
        )
      },
      { metaViz: 'assignees' },
    )
    const answers: { name: string; args: unknown; settle: (e?: unknown) => void }[] = []
    network.mutation.mockImplementation(
      (ref, args) =>
        new Promise((resolve, reject) => {
          const name = getFunctionName(ref)
          if (name === 'identity:claimMySeats') return resolve(null)
          answers.push({ name, args, settle: (e) => (e ? reject(e) : resolve(null)) })
        }),
    )
    await board.render(root)
    return { board, answers }
  }
  /* Status `status`'s cell in the lane of `person`. */
  const laneCell = (person: string, status: string) =>
    [...document.querySelectorAll<HTMLElement>('[data-swimlane-panel]')]
      .find((panel) => panel.querySelector(`[data-lane="assignee:${person}"]`))
      ?.querySelector<HTMLElement>(`[data-board-cell][data-status="${status}"]`)
  const laneOf = (board: { card: (uuid: string) => HTMLElement | null }, uuid: string) =>
    board
      .card(uuid)
      ?.closest('[data-swimlane-panel]')
      ?.querySelector('[data-lane]')
      ?.getAttribute('data-lane')

  it('takes a drop into the lane of someone the write refuses, then puts it back with the server’s reason', async () => {
    const { board, answers } = await lanesBoard()
    await act(async () => board.card('a')?.dispatchEvent(dragEvent('dragstart')))
    // the browser does not judge Vic, so the drop is offered
    const offer = dragEvent('dragover')
    await act(async () => laneCell('vic', 'todo')?.dispatchEvent(offer))
    expect(offer.defaultPrevented).toBe(true)
    await act(async () => laneCell('vic', 'todo')?.dispatchEvent(dragEvent('drop')))
    const writes = answers.filter((a) => a.name === 'issues:update')
    expect(writes.map((w) => (w.args as { patch: unknown }).patch)).toEqual([
      { assignee_id: 'vic' },
    ])
    // painted at once
    expect(laneOf(board, 'a')).toBe('assignee:vic')
    const { ASSIGNEE_RULE } = await import('../../convex/model/issues')
    await act(async () =>
      writes[0].settle(new ConvexError({ code: 'rule', message: ASSIGNEE_RULE })),
    )
    await act(async () => await new Promise((r) => setTimeout(r, 0)))
    expect(laneOf(board, 'a')).toBe(`assignee:${board.snapshot.profiles[0].id}`)
    expect(window.showToast).toHaveBeenCalledWith(
      expect.stringContaining(
        'A task can only be assigned to an active user with Edit permission or higher on its project',
      ),
      'error',
    )
  })

  it('writes a drop into the lane of someone who may take the task', async () => {
    const { board, answers } = await lanesBoard()
    await act(async () => board.card('a')?.dispatchEvent(dragEvent('dragstart')))
    await act(async () => laneCell('olle', 'progress')?.dispatchEvent(dragEvent('dragover')))
    await act(async () => laneCell('olle', 'progress')?.dispatchEvent(dragEvent('drop')))
    expect(
      answers
        .filter((a) => a.name === 'issues:update')
        .map((w) => (w.args as { patch: unknown }).patch),
    ).toEqual([{ assignee_id: 'olle', status: 'progress' }])
    expect(laneOf(board, 'a')).toBe('assignee:olle')
  })

  it('keeps a drag whose card is still on the page', async () => {
    const board = await loadBoard(network, (snap) => {
      snap.issues.push(taskRow(snap, 'a', 'todo', 1))
    })
    await board.render(root)
    const row = (uuid: string) => board.card(uuid)
    const { isUpdateBlocked } = await import('../lib/updateSafety')
    await act(async () => row('a')?.dispatchEvent(dragEvent('dragstart')))
    board.snapshot.issues[0].title = 'Renamed elsewhere'
    await board.deliver()
    await act(async () => window.dispatchEvent(new Event('pointermove')))
    expect(isUpdateBlocked()).toBe(true)
    await act(async () => row('a')?.dispatchEvent(dragEvent('dragend')))
    expect(isUpdateBlocked()).toBe(false)
  })
})
