// @vitest-environment jsdom
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { pastCloseTicks } from '../lib/discardQuestion.setup'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* Closing the task window while it holds text the person typed and has not
   sent, on the real store and the real editors. The window closes the way
   App's close does (closeOrAsk with the window's scope), and the question
   is the one mounted at the root. Writes never answer, so a sent comment
   stays on its way. The last block leaves the title field unchanged. */

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

const AT = '2026-09-14T08:00:00.000Z'

let container: HTMLDivElement
let root: Root
let onClose: ReturnType<typeof vi.fn<() => void>>
let close: () => Promise<void>
/** Takes the task window away, as App does once its close goes ahead. */
let unmountTask: () => Promise<void>

/** The comment the signed-in person wrote on the task, when `open` has one. */
const COMMENT = '00000000-0000-4000-8000-000000000002'

async function open({ embedded = false, title = 'Run the soak test', comment = false } = {}) {
  vi.resetModules()
  const snap: Snapshot = plannerFixture()
  const comments = comment
    ? [
        {
          id: COMMENT,
          issue_id: 'task-a',
          author: snap.profiles[0].id,
          body: 'Check 2',
          created_at: AT,
        },
      ]
    : []
  snap.issues.push({
    id: 'task-a',
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
    num: 27,
    title,
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
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (name === 'snapshot:threadComments') next({ comments, earlier: false })
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
/** Waits for the discard question, which a busy worker renders later. */
const asked = (text: string) =>
  act(() => vi.waitFor(() => expect(question()).toBe(text), { timeout: 5_000 }))
/** Presses `selector`, then lets a close's two ticks pass. */
const press = (selector: string) =>
  act(async () => {
    document.querySelector<HTMLElement>(selector)?.click()
    await pastCloseTicks()
  })
/** The titles sent to the server. */
const renames = () =>
  network.mutation.mock.calls
    .filter(([ref, args]) => getFunctionName(ref) === 'issues:update' && 'title' in args.patch)
    .map(([, args]) => args.patch.title)
/** Drops the connection long enough that edits pause, once the window's
    editors have loaded, as they had after the real wait this replaces. The
    wait runs on fake timers. The status reads Date.now() when its timer
    fires, so Date is fake too. Its clock starts the wait's length in the
    past, so once the real timers are back the drop lies that far behind
    Date.now(), as after a real wait. Going back to real timers drops any
    timer still pending, so none may be. */
async function goOffline() {
  await editorOf('Task description')
  await editorOf('Leave a comment')
  const { syncStatus, OFFLINE_DELAY_MS } = await import('../lib/syncStatus')
  const wait = OFFLINE_DELAY_MS + 50
  vi.useFakeTimers({
    now: Date.now() - wait,
    toFake: ['Date', 'setTimeout', 'clearTimeout'],
    // a timer set before the wait stays real, and clearing it still works
    shouldClearNativeTimers: true,
  })
  try {
    await act(async () => {
      syncStatus.setSocket({ connected: true, everConnected: true })
      syncStatus.setSocket({ connected: false, everConnected: true })
      await vi.advanceTimersByTimeAsync(wait)
    })
    expect(vi.getTimerCount(), 'timers pending after the wait').toBe(0)
  } finally {
    vi.useRealTimers()
  }
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
        await pastCloseTicks()
      })
    await act(async () => composer.commands.insertContent('Drift is under 2%'))
    // an Escape that ends an input method's composition is the input method's
    await act(async () => {
      toolbar?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }),
      )
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(question()).toBeNull()
    await escapeOn()
    await asked('Discard your unsent comment?')
    await press('[data-discard-confirm]')
    expect(composer.getText()).toBe('')
    await act(async () => composer.commands.insertContent('Drift is under 3%'))
    await escapeOn()
    await asked('Discard your unsent comment?')
    await press('[data-discard-keep]')
    expect(composer.getText()).toBe('Drift is under 3%')
    // the editor's own question never closes the window
    expect(onClose).not.toHaveBeenCalled()
  })

  /** Escape inside the text of the editor labelled `label`, past the
      close's two ticks. ProseMirror reads keyCode, and takes Escape as its
      own. */
  const escapeIn = (label: string) =>
    act(async () => {
      document.querySelector(`[role="textbox"][aria-label="${label}"]`)?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          keyCode: 27,
          bubbles: true,
          cancelable: true,
        }),
      )
      await pastCloseTicks()
    })

  it('asks before Escape inside the description throws its draft away', async () => {
    await open()
    const description = await editorOf('Task description')
    await act(async () => description.commands.insertContent(' Twice.'))
    await escapeIn('Task description')
    await asked('Discard your unsent description?')
    await press('[data-discard-keep]')
    expect(description.getText()).toContain('Twice.')
    await escapeIn('Task description')
    await asked('Discard your unsent description?')
    await press('[data-discard-confirm]')
    expect(description.getText()).toBe('Measure the drift.')
    // a clean editor lets go of the text, and the window stays for the next
    // Escape. The discard's own blur waits a frame, so focus comes after it.
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    await act(async () => description.view.focus())
    expect(description.view.hasFocus()).toBe(true)
    await escapeIn('Task description')
    expect(question()).toBeNull()
    await act(() =>
      vi.waitFor(() => expect(description.view.hasFocus()).toBe(false), { timeout: 5_000 }),
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  it('takes a comment out of edit mode on Escape inside its text', async () => {
    await open({ comment: true })
    const editing = () => document.querySelector('[role="textbox"][aria-label="Edit comment"]')
    const edit = `[data-comment="${COMMENT}"] [aria-label="Edit comment"]`
    await press(edit)
    await editorOf('Edit comment')
    // unchanged, it leaves edit mode at once
    await escapeIn('Edit comment')
    expect(question()).toBeNull()
    expect(editing()).toBeNull()
    await press(edit)
    const editor = await editorOf('Edit comment')
    await act(async () => editor.commands.insertContent(' rerun'))
    await escapeIn('Edit comment')
    await asked('Discard your unsent comment?')
    await press('[data-discard-keep]')
    expect(editing()).not.toBeNull()
    expect(editor.getText()).toBe('Check 2 rerun')
    await escapeIn('Edit comment')
    await asked('Discard your unsent comment?')
    await press('[data-discard-confirm]')
    await act(() => vi.waitFor(() => expect(editing()).toBeNull(), { timeout: 5_000 }))
    expect(document.querySelector(`[data-comment="${COMMENT}"]`)?.textContent).toContain('Check 2')
    expect(document.querySelector(`[data-comment="${COMMENT}"]`)?.textContent).not.toContain(
      'rerun',
    )
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
    // the window opens on a later tick
    await vi.waitFor(() =>
      expect(document.querySelector('[data-focus-window="Description"]')).not.toBeNull(),
    )
    const lifted = await editorOf('Task description')
    await act(async () => lifted.commands.insertContent(' Three times.'))
    await press('[data-focus-close]')
    expect(question()).toBe('Discard your unsent description?')
    // Escape answers the question, Keep editing, and leaves the window open
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
      await pastCloseTicks()
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

describe('leaving the title field', { timeout: 30_000 }, () => {
  it('closes a stored title over the cap left as it was without a word', async () => {
    await open({ title: 'r'.repeat(256) })
    await press('[data-task-title]')
    const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task title"]')
    expect(field?.getAttribute('aria-invalid')).toBe('true')
    await act(async () => field?.blur())
    expect(document.querySelector('textarea[aria-label="Task title"]')).toBeNull()
    expect(window.showToast).not.toHaveBeenCalled()
    expect(renames()).toEqual([])
  })
})
