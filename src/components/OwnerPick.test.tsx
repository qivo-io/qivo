// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The owner picker on the real store: a pick counts on the Team sync row
   (onPick) only once the server saves it, and a list that may no longer
   write (`off`) writes nothing and asks to close. Each task write is
   answered by hand. */

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

type Answer = { resolve: (value: null) => void; reject: (reason: unknown) => void }

const NOW = '2026-09-14T08:00:00.000Z'

let container: HTMLDivElement
let root: Root
let writes: Answer[]
let onPick: ReturnType<typeof vi.fn<() => void>>
/* Renders the list again with `off`, as Team sync's stale meeting does,
   with a close that keeps it mounted, as in the render before it closes;
   answers how often it asked to close. */
let renderOff: (off: string) => Promise<ReturnType<typeof vi.fn>>

beforeEach(async () => {
  vi.resetModules()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // cmdk measures its list
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  Element.prototype.scrollIntoView = () => {}
  window.showToast = vi.fn()
  const snap: Snapshot = plannerFixture()
  snap.issues.push({
    id: 'task-a',
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
    num: 27,
    title: 'Run the soak test',
    description: '',
    status: 'progress',
    priority: 'medium',
    paused: false,
    assignee_id: snap.profiles[0].id,
    created_at: NOW,
    updated_at: NOW,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  writes = []
  network.onUpdate.mockImplementation((ref, _args, next) => {
    if (getFunctionName(ref) === 'workspace:whole') next(structuredClone(snap))
    return () => {}
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockImplementation(
    (ref) =>
      new Promise((resolve, reject) => {
        if (getFunctionName(ref) !== 'issues:update') return resolve(null)
        writes.push({ resolve, reject })
      }),
  )
  const store = await import('../store/planner')
  await store.initStore()
  const { OwnerPickList } = await import('./AssigneeAvatar')
  const { TooltipProvider } = await import('./ui/tooltip')
  const task = store.P.issues.find((i) => i.uuid === 'task-a')
  if (!task) throw new Error('missing the task')
  onPick = vi.fn<() => void>()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <TooltipProvider>
        <OwnerPickList issue={task} onClose={(then) => then()} onPick={onPick} />
      </TooltipProvider>,
    ),
  )
  renderOff = async (off) => {
    const onClose = vi.fn()
    await act(async () =>
      root.render(
        <TooltipProvider>
          <OwnerPickList issue={task} onClose={onClose} onPick={onPick} off={off} />
        </TooltipProvider>,
      ),
    )
    return onClose
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Picks Unassigned, which takes the task from its assignee. */
const unassign = () =>
  act(async () =>
    [...container.querySelectorAll<HTMLElement>('[cmdk-item]')]
      .find((item) => item.textContent === 'Unassigned')
      ?.click(),
  )

describe('the owner picker', () => {
  it('runs onPick once the server saves the pick', async () => {
    await unassign()
    expect(writes).toHaveLength(1)
    expect(onPick).not.toHaveBeenCalled()
    await act(async () => writes[0].resolve(null))
    expect(onPick).toHaveBeenCalledTimes(1)
  })

  it('writes nothing while it may not write, its rows saying why, and asks to close', async () => {
    const why = 'This meeting stopped updating. Choose a smaller team or project.'
    const onClose = await renderOff(why)
    expect(onClose).toHaveBeenCalledTimes(1)
    const rows = [...container.querySelectorAll<HTMLElement>('[cmdk-item]')]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.getAttribute('aria-disabled')).toBe('true')
      expect(row.title).toBe(why)
    }
    await unassign()
    expect(writes).toHaveLength(0)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('leaves onPick out when the server refuses the pick', async () => {
    await unassign()
    await act(async () =>
      writes[0].reject(new ConvexError({ code: 'forbidden', message: 'no write access' })),
    )
    expect(onPick).not.toHaveBeenCalled()
  })
})
