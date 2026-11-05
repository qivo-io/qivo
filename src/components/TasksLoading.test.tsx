// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskLoad } from '../store/planner'
import { TooltipProvider } from './ui/tooltip'

/* The note at the bottom and the pages that wait for every task
   (TasksLoading.tsx): the load shows with no share, since the task windows'
   answers come as one or two large transitions after a small first one, a
   page that needs every task asks for them as it mounts, and a stopped load
   offers Try again on the note and on those pages. */

const store = vi.hoisted(() => ({
  load: { state: 'not_asked' } as TaskLoad,
  askTasks: vi.fn(),
  retryTasks: vi.fn(),
}))
vi.mock('../store/planner', () => ({
  P: {
    taskLoad: () => store.load,
    askTasks: store.askTasks,
    retryTasks: store.retryTasks,
  },
  TASKS_FAILED_TEXT: 'Tasks did not load. Changes you make show as you made them until they do.',
}))
vi.mock('../store/usePlannerVersion', () => ({ usePlannerVersion: () => ({ revision: 0 }) }))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  store.load = { state: 'not_asked' }
  store.askTasks.mockClear()
  store.retryTasks.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const bar = () => container.querySelector<HTMLElement>('[data-slot="progress"]')

describe('the note while every task loads', () => {
  it('shows nothing before an ask and once every task is held', async () => {
    const { TasksLoadingBar } = await import('./TasksLoading')
    for (const state of ['not_asked', 'all'] as const) {
      store.load = { state }
      await act(async () => root.render(<TasksLoadingBar />))
      expect(container.querySelector('[data-tasks-loading]'), state).toBeNull()
    }
  })

  it('says Loading tasks… with a bar that shows no share while they arrive', async () => {
    const { TasksLoadingBar } = await import('./TasksLoading')
    store.load = { state: 'arriving' }
    await act(async () => root.render(<TasksLoadingBar />))
    const note = container.querySelector('[data-tasks-loading]')
    expect(note?.textContent).toBe('Loading tasks…')
    // indeterminate, with no value and no percentage anywhere
    expect(bar()?.dataset.state).toBe('indeterminate')
    expect(bar()?.hasAttribute('aria-valuenow')).toBe(false)
    expect(container.textContent).not.toMatch(/\d+%/)
  })

  it('says why the load stopped and that changes show as made, with Try again and no bar', async () => {
    const { TasksLoadingBar } = await import('./TasksLoading')
    store.load = { state: 'failed', reason: 'Every task did not arrive in time.', retrying: false }
    const render = () =>
      act(async () =>
        root.render(
          <TooltipProvider>
            <TasksLoadingBar />
          </TooltipProvider>,
        ),
      )
    await render()
    const note = container.querySelector('[data-tasks-loading]')
    expect(note?.textContent).toContain(
      'Tasks did not load. Changes you make show as you made them until they do.',
    )
    expect(note?.textContent).toContain('Every task did not arrive in time.')
    expect(bar()).toBeNull()
    const retry = () =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Try again')
    expect(retry()?.disabled).toBe(false)
    await act(async () => retry()?.click())
    expect(store.retryTasks).toHaveBeenCalledTimes(1)
    // while Try again runs, it waits
    store.load = { state: 'failed', reason: 'Every task did not arrive in time.', retrying: true }
    await render()
    expect(retry()?.disabled).toBe(true)
  })
})

describe('a page that needs every task', () => {
  it('asks for every task with its reason as it mounts, and shows the load with no share', async () => {
    const { TasksLoadingView } = await import('./TasksLoading')
    store.load = { state: 'arriving' }
    await act(async () => root.render(<TasksLoadingView what="The roadmap" reason="roadmap" />))
    expect(store.askTasks).toHaveBeenCalledWith('roadmap')
    expect(container.textContent).toContain('The roadmap opens once every task has loaded.')
    expect(container.textContent).toContain('Loading tasks…')
    expect(bar()?.dataset.state).toBe('indeterminate')
    expect(container.textContent).not.toMatch(/\d+%/)
  })

  it('says why the load stopped and runs it again on Try again', async () => {
    const { TasksLoadingView } = await import('./TasksLoading')
    store.load = { state: 'failed', reason: 'Every task did not arrive in time.', retrying: false }
    await act(async () =>
      root.render(
        <TooltipProvider>
          <TasksLoadingView what="Team sync" reason="team_sync" />
        </TooltipProvider>,
      ),
    )
    expect(store.askTasks).toHaveBeenCalledWith('team_sync')
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Changes you make show as you made them')
    expect(container.textContent).toContain('Every task did not arrive in time.')
    const retry = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Try again',
    )
    expect(retry?.disabled).toBe(false)
    await act(async () => retry?.click())
    expect(store.retryTasks).toHaveBeenCalledTimes(1)
    // while Try again runs, it waits
    store.load = { state: 'failed', reason: 'Every task did not arrive in time.', retrying: true }
    await act(async () =>
      root.render(
        <TooltipProvider>
          <TasksLoadingView what="Team sync" reason="team_sync" />
        </TooltipProvider>,
      ),
    )
    const waiting = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Try again',
    )
    expect(waiting?.disabled).toBe(true)
  })
})
