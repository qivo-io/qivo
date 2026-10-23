// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TasksLoadingBar } from './TasksLoading'

/* The loading note says what the person waits for, so a workspace whose
   tasks stop arriving for a while does not look frozen. */

const store = vi.hoisted(() => ({
  share: 0.125 as number | null,
  waiting: false,
  trouble: null as null | { kind: string },
}))
vi.mock('../store/planner', () => ({
  P: {
    stillLoading: () => store.share,
    waitingForServer: () => store.waiting,
    snapshotTrouble: () => store.trouble,
  },
}))
vi.mock('../store/usePlannerVersion', () => ({ usePlannerVersion: () => 0 }))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.assign(store, { share: 0.125, waiting: false, trouble: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const note = async () => {
  await act(async () => root.render(<TasksLoadingBar />))
  return container.querySelector('[data-tasks-loading]')?.textContent ?? null
}

describe('the loading note', () => {
  it('says the tasks load, that it waits for the server, or where loading stopped', async () => {
    expect(await note()).toBe('Loading tasks… 12%')
    store.waiting = true
    expect(await note()).toBe('Waiting for the server… 12%')
    store.trouble = { kind: 'failed' }
    expect(await note()).toBe('Tasks stopped loading at 12%')
    store.share = null
    expect(await note()).toBeNull()
  })
})
