// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* A walk's Remaining box on the real store: a typed number counts the row
   as reviewed only once the server saves it. Each task write is answered by
   hand. */

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
let onCommit: ReturnType<typeof vi.fn<() => void>>

beforeEach(async () => {
  vi.resetModules()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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
    remaining_hours: 4,
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
  const { RemainingInput } = await import('./walk')
  const { TooltipProvider } = await import('./ui/tooltip')
  const task = store.P.issues.find((i) => i.uuid === 'task-a')
  if (!task) throw new Error('missing the task')
  onCommit = vi.fn<() => void>()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <TooltipProvider>
        <RemainingInput hook="ue" it={task} title="Remaining" onCommit={onCommit} />
      </TooltipProvider>,
    ),
  )
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Types `hours` into the box and leaves it, which saves. */
async function enter(hours: string) {
  const box = container.querySelector<HTMLInputElement>('[data-ue-input]')
  if (!box) throw new Error('missing the box')
  await act(async () => {
    box.focus()
    box.value = hours
    box.blur()
  })
}

describe("a walk's Remaining box", () => {
  it('counts the row as reviewed once the server saves the hours', async () => {
    await enter('6')
    expect(writes).toHaveLength(1)
    expect(onCommit).not.toHaveBeenCalled()
    await act(async () => writes[0].resolve(null))
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('leaves the row unreviewed when the server refuses the hours', async () => {
    await enter('6')
    await act(async () =>
      writes[0].reject(new ConvexError({ code: 'forbidden', message: 'no write access' })),
    )
    expect(onCommit).not.toHaveBeenCalled()
    expect(window.showToast).toHaveBeenCalledWith(
      "You don't have permission for that. Change reverted.",
      'error',
    )
  })
})
