// @vitest-environment jsdom
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The task window opened while the connection is down, before the editor's
   code has downloaded: the description shows as plain text in the editor's
   place, the window stays usable, and the editor takes over once the
   connection is back (EditorSlot in IssueDetail). */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const AT = '2026-09-14T08:00:00.000Z'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const description = () =>
  document.querySelector<TiptapEditorHTMLElement>('[role="textbox"][aria-label="Task description"]')

describe('the task editor while its code waits for the connection', { timeout: 20_000 }, () => {
  it('shows the description as text in its place and loads the editor once connected', async () => {
    vi.resetModules()
    const snap: Snapshot = plannerFixture()
    snap.issues.push({
      id: 'task-a',
      org_id: snap.orgs[0].id,
      project_id: snap.projects[0].id,
      num: 27,
      title: 'Run the soak test',
      description: 'Measure the **drift** twice.',
      status: 'progress',
      priority: 'medium',
      paused: false,
      created_at: AT,
      updated_at: AT,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    network.onUpdate.mockImplementation((ref, _args, next) => {
      const name = getFunctionName(ref)
      if (name === 'snapshot:forMe') next(structuredClone(snap))
      else if (name === 'snapshot:commentThread') next({ comments: [], earlier: false, events: [] })
      return () => {}
    })
    network.query.mockResolvedValue(null)
    network.mutation.mockResolvedValue(null)
    const { syncStatus } = await import('../lib/syncStatus')
    const store = await import('../store/planner')
    await store.initStore()
    const { IssueDetail } = await import('./IssueDetail')
    const { loadDescEditor } = await import('../lib/workspaceChunks')
    syncStatus.setSocket({ connected: true, everConnected: true })
    // down, but not yet long enough for the offline notice
    syncStatus.setSocket({ connected: false, everConnected: true })

    const task = store.P.issues.find((it) => it.uuid === 'task-a')
    if (!task) throw new Error('missing the task')
    await act(async () =>
      root.render(
        <TooltipProvider>
          <IssueDetail issueId={task.id} onClose={vi.fn()} onOpen={vi.fn()} />
        </TooltipProvider>,
      ),
    )
    const text = container.textContent ?? ''
    expect(text).toContain('Run the soak test')
    expect(text).toContain('Measure the drift twice.')
    expect(container.querySelector('strong')?.textContent).toBe('drift')
    expect(text).not.toContain('offline')
    expect(text).not.toContain('could not be loaded')
    expect(description()).toBeNull()
    expect(loadDescEditor.loading()).toBe(false)

    await act(async () => syncStatus.setSocket({ connected: true, everConnected: true }))
    const editor = await vi.waitFor(
      () => {
        const found = description()?.editor
        if (!found) throw new Error('the editor has not loaded')
        return found
      },
      { timeout: 10_000 },
    )
    expect(editor.getText()).toBe('Measure the drift twice.')
  })
})
