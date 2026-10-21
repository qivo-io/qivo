// @vitest-environment jsdom
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* Closing the task window while it holds text the person typed and has not
   sent, on the real store and the real editors. The window closes the way
   App's close does (closeOrAsk with the window's scope), and the question
   is the one mounted at the root. Writes never answer, so a sent comment
   stays on its way. */

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
let onClose: ReturnType<typeof vi.fn<() => void>>
let close: () => Promise<void>
/** Takes the task window away, as App does once its close goes ahead. */
let unmountTask: () => Promise<void>

async function open({ embedded = false } = {}) {
  vi.resetModules()
  const snap: Snapshot = plannerFixture()
  snap.issues.push({
    id: 'task-a',
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
    num: 27,
    title: 'Run the soak test',
    description: 'Measure the drift.',
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
  network.mutation.mockReset()
  network.mutation.mockImplementation((ref) =>
    getFunctionName(ref).startsWith('comments:') ? new Promise(() => {}) : Promise.resolve(null),
  )
  const store = await import('../store/planner')
  await store.initStore()
  const { IssueDetail } = await import('./IssueDetail')
  const { closeOrAsk } = await import('../lib/discardQuestion')
  const { DiscardPrompt } = await import('../components/DiscardPrompt')
  const { createUnsentScope, UnsentScopeContext } = await import('../lib/leaveGuard')
  const scope = createUnsentScope()
  onClose = vi.fn<() => void>()
  // closes as App does, and waits for the answer: the window closed or asked
  close = async () => {
    const before = onClose.mock.calls.length
    await act(async () => {
      closeOrAsk([scope], onClose)
      await vi.waitFor(() => {
        if (question() === null && onClose.mock.calls.length === before)
          throw new Error('no answer yet')
      })
    })
  }
  const task = store.P.issues.find((it) => it.uuid === 'task-a')
  if (!task) throw new Error('missing the task')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <UnsentScopeContext.Provider value={scope}>
          <IssueDetail issueId={task.id} onClose={close} onOpen={vi.fn()} embedded={embedded} />
        </UnsentScopeContext.Provider>
        <DiscardPrompt />
      </TooltipProvider>,
    ),
  )
  unmountTask = () =>
    act(async () =>
      root.render(
        <TooltipProvider>
          <DiscardPrompt />
        </TooltipProvider>,
      ),
    )
}

beforeEach(() => {
  // jsdom lays nothing out; ProseMirror measures a Range for the caret
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
const question = () => document.querySelector('[data-discard-prompt] h2')?.textContent ?? null
/** Presses `selector`, then lets a close's two ticks pass. */
const press = (selector: string) =>
  act(async () => {
    document.querySelector<HTMLElement>(selector)?.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
/** The titles sent to the server. */
const renames = () =>
  network.mutation.mock.calls
    .filter(([ref, args]) => getFunctionName(ref) === 'issues:update' && 'title' in args.patch)
    .map(([, args]) => args.patch.title)
/** Drops the connection long enough that edits pause. */
async function goOffline() {
  const { syncStatus, OFFLINE_DELAY_MS } = await import('../lib/syncStatus')
  await act(async () => {
    syncStatus.setSocket({ connected: true, everConnected: true })
    syncStatus.setSocket({ connected: false, everConnected: true })
    await new Promise((resolve) => setTimeout(resolve, OFFLINE_DELAY_MS + 50))
  })
}
/** Types `value` into the title field as React reads input. */
async function typeTitle(value: string) {
  const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task title"]')
  if (!field) throw new Error('missing the title field')
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('closing the task window with unsent text', { timeout: 30_000 }, () => {
  it('asks before a typed comment is lost, keeps it on Keep editing and closes on Discard', async () => {
    await open()
    const composer = await editorOf('Leave a comment')
    await act(async () => composer.commands.insertContent('Drift is under 2%'))
    await close()
    expect(question()).toBe('Discard your unsent comment?')
    await press('[data-discard-keep]')
    expect(question()).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(composer.getText()).toBe('Drift is under 2%')
    await close()
    await press('[data-discard-confirm]')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes without asking when nothing was typed, or the typed text was removed', async () => {
    await open()
    const composer = await editorOf('Leave a comment')
    await close()
    expect(question()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
    await act(async () => composer.commands.insertContent('Drift'))
    await act(async () => composer.commands.clearContent(true))
    await close()
    expect(question()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('saves a title edit as it leaves the field, and asks about one a pause refused', async () => {
    await open()
    await press('[data-task-title]')
    await typeTitle('Run the soak test twice')
    await close()
    expect(question()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(renames()).toEqual(['Run the soak test twice'])

    await goOffline()
    await press('[data-task-title]')
    await typeTitle('Run the soak test three times')
    await close()
    expect(question()).toBe('Discard your unsent title?')
    await press('[data-discard-keep]')
    // focus goes back to the field once the question has gone
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Task title'),
    )
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('names a description edit, and not a title typed back', async () => {
    await open()
    await goOffline()
    await press('[data-task-title]')
    await typeTitle('Run the soak test twice')
    await typeTitle('Run the soak test')
    const description = await editorOf('Task description')
    await act(async () => description.commands.insertContent(' Twice.'))
    await close()
    expect(question()).toBe('Discard your unsent description?')
    await press('[data-discard-keep]')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('asks before Escape on the composer controls throws its draft away', async () => {
    await open()
    const composer = await editorOf('Leave a comment')
    const toolbar = document
      .querySelector('[role="textbox"][aria-label="Leave a comment"]')
      ?.closest('.mdwrap')
      ?.querySelector<HTMLElement>('[aria-label="Formatting"]')
    /** Escape inside the composer's controls, past the close's two ticks. A
        focused button would show its tooltip, which passes Escape on to the
        window instead. */
    const escapeOn = () =>
      act(async () => {
        toolbar?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
    await act(async () => composer.commands.insertContent('Drift is under 2%'))
    await escapeOn()
    expect(question()).toBe('Discard your unsent comment?')
    await press('[data-discard-confirm]')
    expect(composer.getText()).toBe('')
    await act(async () => composer.commands.insertContent('Drift is under 3%'))
    await escapeOn()
    expect(question()).toBe('Discard your unsent comment?')
    await press('[data-discard-keep]')
    expect(composer.getText()).toBe('Drift is under 3%')
    // the editor's own question never closes the window
    expect(onClose).not.toHaveBeenCalled()
  })

  it('leaves the draft and the window alone on Escape inside the text', async () => {
    await open()
    const composer = await editorOf('Leave a comment')
    await act(async () => composer.commands.insertContent('Drift is under 2%'))
    const text = document.querySelector<HTMLElement>(
      '[role="textbox"][aria-label="Leave a comment"]',
    )
    await act(async () => {
      // ProseMirror reads keyCode, and takes Escape as its own
      text?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          keyCode: 27,
          bubbles: true,
          cancelable: true,
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(question()).toBeNull()
    expect(composer.getText()).toBe('Drift is under 2%')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('asks before a description draft moves into or out of its own window', async () => {
    await open()
    const column = await editorOf('Task description')
    await act(async () => column.commands.insertContent(' Twice.'))
    await press('[data-desc-popout]')
    expect(question()).toBe('Discard your unsent description?')
    await press('[data-discard-keep]')
    expect(document.querySelector('[data-focus-window]')).toBeNull()
    await press('[data-desc-popout]')
    await press('[data-discard-confirm]')
    expect(document.querySelector('[data-focus-window="Description"]')).not.toBeNull()
    const lifted = await editorOf('Task description')
    await act(async () => lifted.commands.insertContent(' Three times.'))
    await press('[data-focus-close]')
    expect(question()).toBe('Discard your unsent description?')
    // Escape answers the question, Keep editing, and leaves the window open
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(question()).toBeNull()
    expect(document.querySelector('[data-focus-window="Description"]')).not.toBeNull()
    expect(lifted.getText()).toContain('Three times.')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('asks before collapsing the Inbox pane description with a draft in it', async () => {
    await open({ embedded: true })
    await press('[data-desc-toggle]')
    const description = await editorOf('Task description')
    await act(async () => description.commands.insertContent(' Twice.'))
    await press('[data-desc-toggle]')
    expect(question()).toBe('Discard your unsent description?')
    await press('[data-discard-keep]')
    expect(description.getText()).toContain('Twice.')
    await press('[data-desc-toggle]')
    await press('[data-discard-confirm]')
    expect(document.querySelector('[role="textbox"][aria-label="Task description"]')).toBeNull()
  })

  it('says nothing of the text the person chose to discard as the window goes', async () => {
    await open()
    const composer = await editorOf('Leave a comment')
    const description = await editorOf('Task description')
    await act(async () => composer.commands.insertContent('Drift is under 2%'))
    await act(async () => description.commands.insertContent(' Twice.'))
    await close()
    await press('[data-discard-confirm]')
    expect(onClose).toHaveBeenCalledTimes(1)
    await unmountTask()
    expect(window.showToast).not.toHaveBeenCalled()
  })

  it('says the typed text went when the window goes without a Discard', async () => {
    await open()
    const composer = await editorOf('Leave a comment')
    const description = await editorOf('Task description')
    await act(async () => composer.commands.insertContent('Drift is under 2%'))
    await act(async () => description.commands.insertContent(' Twice.'))
    // a remote delete takes the window away without asking
    await unmountTask()
    const said = vi.mocked(window.showToast).mock.calls.map(([text]) => text)
    expect(said).toContain('Unsaved comment discarded')
    expect(said).toContain('Unsaved description changes discarded')
  })

  it('does not ask about a comment on its way to the server', async () => {
    await open()
    const composer = await editorOf('Leave a comment')
    await act(async () => composer.commands.insertContent('Drift is under 2%'))
    const send = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Comment')
    await act(async () => send?.click())
    await close()
    expect(question()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
