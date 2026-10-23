// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOARD_TEST_TIMEOUT, cell, loadBoard, taskRow } from '../views/boardFixture.setup'

/* Closing a task window returns focus to the Board card it was opened
   from, also when an edit in the window moved that card to another cell.
   The Board and the window share one root, as in App. */

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
  // jsdom lays nothing out; ProseMirror measures a Range for the caret
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.scrollIntoView = vi.fn()
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
  vi.spyOn(console, 'error').mockImplementation(() => {})
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
})

/** Lets the window's timers and frames run. */
const settle = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 50)))

describe('closing a task window', { timeout: BOARD_TEST_TIMEOUT }, () => {
  type Board = Awaited<ReturnType<typeof loadBoard>>
  /* Opens A from its card's title, applies `edit` in the window, given a way
     to open another task there, and closes it. The window stays mounted
     with no task, as App keeps it. Returns the title of `uuid`'s card as
     the Board shows it afterwards. */
  async function openEditClose(
    edit: (board: Board, open: (id: string) => void) => unknown,
    uuid = 'a',
    backlog = 0,
  ) {
    const board = await loadBoard(network, (snap) => {
      snap.issues.push(taskRow(snap, 'a', 'todo', 1), taskRow(snap, 'b', 'todo', 2))
      for (let n = 0; n < backlog; n++)
        snap.issues.push(taskRow(snap, `backlog-${n}`, 'backlog', n + 3))
    })
    const { IssueDetail } = await import('./IssueDetail')
    let openTask: (id: string) => void = () => {}
    await board.render(root, (opened, close, open) => {
      openTask = open
      return <IssueDetail issueId={opened} onClose={close} onOpen={open} />
    })
    const title = () => board.card('a')?.querySelector<HTMLElement>('[data-focus-key="title"]')
    await act(async () => {
      title()?.focus()
      title()?.click()
    })
    await settle()
    expect(document.querySelector('[data-task-close]')).not.toBeNull()
    await act(async () => {
      await edit(board, openTask)
    })
    await settle()
    await act(async () => document.querySelector<HTMLElement>('[data-task-close]')?.click())
    await settle()
    expect(document.querySelector('[data-task-close]')).toBeNull()
    return board.card(uuid)?.querySelector<HTMLElement>('[data-focus-key="title"]')
  }

  it('returns focus to the card where the edit moved it', async () => {
    const title = await openEditClose(({ P }) => {
      const a = P.issues.find((it) => it.uuid === 'a')!
      P.updateIssue(a.id, { status: 'progress' })
    })
    expect(cell('progress')?.contains(title!)).toBe(true)
    expect(document.activeElement).toBe(title)
  })

  it('returns focus to the card where the edit moved it while the Board still mounts', async () => {
    // a large Board whose slices never run: In Progress mounts none of its
    // cards until something asks for one
    vi.stubGlobal(
      'MessageChannel',
      class {
        port1 = { onmessage: null, close() {} }
        port2 = { postMessage() {} }
      },
    )
    const title = await openEditClose(
      ({ P }) => {
        const a = P.issues.find((it) => it.uuid === 'a')!
        P.updateIssue(a.id, { status: 'progress' })
      },
      'a',
      400,
    )
    expect(document.querySelector('[data-board-mount]')?.getAttribute('data-board-mount')).toBe(
      'pending',
    )
    expect(cell('progress')?.contains(title!)).toBe(true)
    expect(document.activeElement).toBe(title)
  })

  it('returns focus to the card it was opened from', async () => {
    const title = await openEditClose(() => {})
    expect(cell('todo')?.contains(title!)).toBe(true)
    expect(document.activeElement).toBe(title)
  })

  it('does not return focus to a card in a view kept hidden behind another page', async () => {
    const title = await openEditClose(() => {
      // the scope changed as the window closed: the Board is kept, hidden
      container.setAttribute('data-hidden-view', 'kanban')
    })
    expect(title).toBeTruthy()
    // no card of the hidden Board takes it (the window, in this one root,
    // holds it)
    expect(document.activeElement).not.toBe(title)
    expect(document.activeElement?.closest('[data-card]')).toBeNull()
  })

  it("returns focus to the shown task's card when the opener's task is gone", async () => {
    const title = await openEditClose(async (board, open) => {
      // the window moves on to B; elsewhere A is archived and B moved on, so
      // no card is left where A was
      open(board.P.issues.find((it) => it.uuid === 'b')!.id)
      board.snapshot.issues = board.snapshot.issues.filter((issue) => issue.id !== 'a')
      board.snapshot.issues.find((issue) => issue.id === 'b')!.status = 'review'
      await board.deliver()
    }, 'b')
    expect(title).toBeTruthy()
    expect(document.activeElement).toBe(title)
  })
})
