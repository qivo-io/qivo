// @vitest-environment jsdom
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture } from '../store/plannerFixture.setup'

/* A new task's window when the server refuses the create, on the real store
   and the real editors. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

let container: HTMLDivElement
let root: Root
let refuse: (error: unknown) => void

beforeEach(() => {
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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

/** The editor labelled `label`, once its lazy module has loaded. */
function editorOf(label: string) {
  return vi.waitFor(
    () => {
      const selector = `[role="textbox"][aria-label="${label}"]`
      const found = document.querySelector<TiptapEditorHTMLElement>(selector)?.editor
      if (!found) throw new Error(`missing the ${label} editor`)
      return found
    },
    { timeout: 10_000 },
  )
}

/** Opens the window of a new task the server has not answered yet, closing
    it on a refusal as App does. */
async function openNewTask() {
  vi.resetModules()
  const snap = plannerFixture()
  network.onUpdate.mockImplementation((ref, _args, next) => {
    const name = getFunctionName(ref)
    if (name === 'snapshot:forMe') next(structuredClone(snap))
    else if (name === 'snapshot:commentThread') next({ comments: [], earlier: false, events: [] })
    return () => {}
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockImplementation((ref) => {
    const name = getFunctionName(ref)
    if (name === 'issues:create')
      return new Promise((_resolve, reject) => {
        refuse = reject
      })
    return name.startsWith('comments:') ? new Promise(() => {}) : Promise.resolve(null)
  })
  const store = await import('../store/planner')
  await store.initStore()
  const { IssueDetail } = await import('./IssueDetail')
  const { DiscardPrompt } = await import('../components/DiscardPrompt')
  const { dropRefusedTask } = await import('../lib/closingMoves')
  const { createUnsentScope, UnsentScopeContext } = await import('../lib/leaveGuard')
  const scope = createUnsentScope()
  let shown: string | null = null
  const render = () =>
    root.render(
      <TooltipProvider>
        <UnsentScopeContext.Provider value={scope}>
          {shown && <IssueDetail issueId={shown} onClose={vi.fn()} onOpen={vi.fn()} />}
        </UnsentScopeContext.Provider>
        <DiscardPrompt />
      </TooltipProvider>,
    )
  const key = store.P.addIssue({ project: snap.projects[0].id, title: 'New task' }, (last) => {
    // App's close of a refused task's window
    const lost = dropRefusedTask(scope, last)
    shown = null
    render()
    if (lost) window.showToast?.(lost, 'error')
  })
  shown = key
  await act(async () => render())
  return key
}

/** Refuses the create and lets the window close. */
const refused = () =>
  act(async () => {
    refuse(new ConvexError({ code: 'forbidden', message: 'no write access to this project' }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
const toasts = () => vi.mocked(window.showToast).mock.calls.map(([text]) => text)

describe('a new task the server refuses', { timeout: 30_000 }, () => {
  it('closes its window and says the text typed in it went with it', async () => {
    const key = await openNewTask()
    const composer = await editorOf('Leave a comment')
    await act(async () => composer.commands.insertContent('Drift is under 2%'))
    const description = await editorOf('Task description')
    await act(async () => description.commands.insertContent(' Twice.'))
    await refused()
    expect(document.querySelector('[role="textbox"]')).toBeNull()
    expect(toasts()).toEqual([
      "You don't have permission for that. Change reverted.",
      `${key} was not created, so its window closed and your unsent comment and description went with it.`,
    ])
  })

  it('says only the refusal when nothing was typed', async () => {
    await openNewTask()
    await editorOf('Leave a comment')
    await refused()
    expect(toasts()).toEqual(["You don't have permission for that. Change reverted."])
  })
})
