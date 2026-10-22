// @vitest-environment jsdom
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../../convex/lib/limits'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'
import type { Row } from '../store/rows'

/* The comment composer and the thread's failed state in the task window, on
   the real store and the real editor. Comment writes and the commentThread
   subscription are answered by hand, and the server answers a new
   subscription after a round trip (`later`). Comment #n is posted n minutes
   after START. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

type Page = { comments: Row<'comments'>[]; earlier: boolean }
type Planner = typeof import('../store/planner')['P']
type Detail = typeof import('./IssueDetail')
type Answer = { resolve: (value: null) => void; reject: (reason: unknown) => void }

const START = Date.parse('2026-09-14T08:00:00.000Z')
const at = (minute: number) => new Date(START + minute * 60_000).toISOString()
// A sample `rule` refusal of a post. The app toasts such a sentence as sent.
const RULE = 'this sample rule refuses the comment; try again later'

let P: Planner
let detail: Detail
let container: HTMLDivElement
let root: Root
let me: string
let deliver: (page: Page) => void
let fail: (e: unknown) => void
let subscriptions: number
let writes: { name: string; answer: Answer }[]
// The failure the client still holds for the thread. ConvexClient keeps a
// query's last result until the server answers the next subscription to it,
// and hands it to a new listener on a 0 ms timer unless the server answered
// that listener first.
let held: unknown

const comment = (n: number): Row<'comments'> => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  issue_id: 'task-a',
  author: me,
  body: `Check ${n}`,
  created_at: at(n),
})
const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, n) => comment(from + n))

/** Loads the store with task QN-27, whose description is `description`. */
async function load(description = '') {
  vi.resetModules()
  const snap: Snapshot = plannerFixture()
  me = snap.profiles[0].id
  snap.issues.push({
    id: 'task-a',
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
    num: 27,
    title: 'Run the soak test',
    description,
    status: 'progress',
    priority: 'medium',
    paused: false,
    created_at: at(0),
    updated_at: at(0),
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  subscriptions = 0
  writes = []
  held = null
  network.onUpdate.mockImplementation((ref, _args, next, onError) => {
    const name = getFunctionName(ref)
    if (name === 'snapshot:forMe') next(structuredClone(snap))
    else if (name === 'snapshot:commentThread') {
      subscriptions++
      let closed = false
      let answered = false
      deliver = (page) => {
        held = null
        answered = true
        // a delivery also carries the task's changes, which these tests leave out
        next({ ...page, events: [] })
      }
      fail = (e) => {
        held = e
        answered = true
        onError(e)
      }
      const cached = held
      if (cached !== null)
        setTimeout(() => {
          if (!closed && !answered) onError(cached)
        }, 0)
      return () => {
        closed = true
      }
    }
    return () => {}
  })
  network.query.mockResolvedValue(null)
  // comment writes wait for the test; others (such as marking the task's
  // messages read on open) succeed
  network.mutation.mockImplementation(
    (ref) =>
      new Promise((resolve, reject) => {
        const name = getFunctionName(ref)
        if (!name.startsWith('comments:')) return resolve(null)
        writes.push({ name, answer: { resolve, reject } })
      }),
  )
  const store = await import('../store/planner')
  P = store.P
  await store.initStore()
  detail = await import('./IssueDetail')
}

beforeEach(() => {
  // jsdom lays nothing out. ProseMirror measures a Range to scroll the caret
  // into view when edit-in-place opens with it at the end.
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
  vi.useRealTimers()
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/* Runs the timers queued so far, such as a held result's redelivery, so
   what the test answers next is the server's. */
const later = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

async function open() {
  const task = P.issues.find((it) => it.uuid === 'task-a')
  if (!task) throw new Error('missing the task')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <detail.IssueDetail issueId={task.id} onClose={vi.fn()} onOpen={vi.fn()} />
      </TooltipProvider>,
    ),
  )
  await later()
}

/* The open edit-in-place editor, or null. */
const editing = () => document.querySelector('[role="textbox"][aria-label="Edit comment"]')
/* The editor labelled `label`, once its lazy module has loaded. The first
   load can take seconds on a busy worker, past waitFor's 1 s default. */
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
function button(name: string) {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent === name)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing ${name}`)
  return found
}
async function click(name: string) {
  await act(async () => button(name).click())
}
/* Comment texts in the thread, oldest first. */
function thread(): string[] {
  return [...document.querySelectorAll('[data-comment]')].map(
    (row) => row.querySelector('.md, p')?.textContent ?? '',
  )
}
const failure = () => document.querySelector<HTMLElement>('[data-thread-failure]')
const spineText = () => document.querySelector('[data-spine]')?.textContent ?? ''

// Each test imports the whole task window afresh, which takes seconds on a
// busy CI worker.
describe('comment drafts in the task window', { timeout: 20_000 }, () => {
  it('keeps the typed comment while the server answers and after it refuses', async () => {
    await load()
    await open()
    await act(async () => deliver({ comments: range(1, 4), earlier: false }))
    const composer = await editorOf('Leave a comment')
    await act(async () => composer.commands.insertContent('One more comment'))
    await click('Comment')
    // posted at once, and the draft waits, locked, for the server
    expect(thread()).toEqual(['Check 1', 'Check 2', 'Check 3', 'One more comment'])
    expect(composer.getText()).toBe('One more comment')
    expect(composer.isEditable).toBe(false)
    expect(button('Comment').disabled).toBe(true)
    expect(button('Discard changes').disabled).toBe(true)
    await act(async () => writes[0].answer.reject(new ConvexError({ code: 'rule', message: RULE })))
    expect(window.showToast).toHaveBeenCalledWith(
      expect.stringContaining('This sample rule refuses the comment'),
      'error',
    )
    expect(thread()).toEqual(['Check 1', 'Check 2', 'Check 3'])
    expect(composer.getText()).toBe('One more comment')
    expect(composer.isEditable).toBe(true)
    expect(button('Comment').disabled).toBe(false)
  })

  it('clears the composer once the server saves the comment', async () => {
    await load()
    await open()
    await act(async () => deliver({ comments: range(1, 4), earlier: false }))
    const composer = await editorOf('Leave a comment')
    await act(async () => composer.commands.insertContent('Soak run finished'))
    await click('Comment')
    expect(composer.getText()).toBe('Soak run finished')
    await act(async () => writes[0].answer.resolve(null))
    expect(composer.getText()).toBe('')
    expect(composer.isEditable).toBe(true)
    expect(thread()).toEqual(['Check 1', 'Check 2', 'Check 3', 'Soak run finished'])
    expect(window.showToast).not.toHaveBeenCalled()
  })

  it('warns before the page closes while the comment is typed or waits, and not after', async () => {
    await load()
    const { installLeaveGuard } = await import('../lib/leaveGuard')
    const remove = installLeaveGuard(P.hasUnsavedWork)
    const leave = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    try {
      await open()
      await act(async () => deliver({ comments: range(1, 4), earlier: false }))
      const composer = await editorOf('Leave a comment')
      expect(leave()).toBe(false)
      await act(async () => composer.commands.insertContent('Soak run finished'))
      expect(leave()).toBe(true)
      await click('Comment')
      // sent, not yet confirmed
      expect(leave()).toBe(true)
      await act(async () => writes[0].answer.resolve(null))
      expect(composer.getText()).toBe('')
      expect(leave()).toBe(false)
    } finally {
      remove()
    }
  })

  it('refuses formatting and link changes to the comment it is sending', async () => {
    await load()
    await open()
    await act(async () => deliver({ comments: range(1, 4), earlier: false }))
    const composer = await editorOf('Leave a comment')
    await act(async () => composer.commands.insertContent('Soak run finished'))
    await click('Comment')
    const sent = composer.getJSON()
    const field = composer.view.dom.closest('.mdwrap')
    const toolbar = [...(field?.querySelectorAll('[data-mdtoolbar] button') ?? [])]
    expect(toolbar.length).toBeGreaterThan(0)
    expect(toolbar.every((b) => b instanceof HTMLButtonElement && b.disabled)).toBe(true)
    // what a toolbar button, the link popover and a mention pick run
    await act(async () => {
      composer.chain().toggleBulletList().run()
      composer
        .chain()
        .insertContent({
          type: 'text',
          text: ' report',
          marks: [{ type: 'link', attrs: { href: 'https://example.com/soak' } }],
        })
        .run()
    })
    expect(composer.getJSON()).toEqual(sent)
    await act(async () => writes[0].answer.resolve(null))
    expect(composer.getText()).toBe('')
    expect(toolbar.every((b) => b instanceof HTMLButtonElement && !b.disabled)).toBe(true)
    expect(thread()).toEqual(['Check 1', 'Check 2', 'Check 3', 'Soak run finished'])
  })

  it('says a comment is discarded when its window closed before the server refused it', async () => {
    await load()
    await open()
    await act(async () => deliver({ comments: range(1, 4), earlier: false }))
    const send = async (text: string) => {
      const composer = await editorOf('Leave a comment')
      await act(async () => composer.commands.insertContent(text))
      await click('Comment')
      await act(async () => root.render(null))
    }
    // Tiptap destroys an unmounted editor on a 1 ms timer. Held here, the
    // refusal lands before it, as it can in the app.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await send('One more comment')
    // it may yet be saved, so closing says nothing
    expect(window.showToast).not.toHaveBeenCalled()
    await act(async () => writes[0].answer.reject(new ConvexError({ code: 'rule', message: RULE })))
    expect(window.showToast).toHaveBeenCalledWith(
      expect.stringContaining('This sample rule refuses the comment'),
      'error',
    )
    expect(window.showToast).toHaveBeenLastCalledWith('Unsaved comment discarded', 'error')
    await act(async () => vi.runOnlyPendingTimers())
    vi.useRealTimers()
    vi.mocked(window.showToast).mockClear()
    await open()
    await send('Soak run finished')
    await act(async () => writes[1].answer.resolve(null))
    expect(window.showToast).not.toHaveBeenCalled()
  })

  it('keeps an edit open with its text when the server refuses it', async () => {
    await load()
    await open()
    await act(async () => deliver({ comments: range(1, 4), earlier: false }))
    const edit = document.querySelector<HTMLButtonElement>(
      `[data-comment="${comment(2).id}"] [aria-label="Edit comment"]`,
    )
    await act(async () => edit?.click())
    const editor = await editorOf('Edit comment')
    await act(async () => editor.commands.insertContent(' rerun'))
    await click('Save')
    await act(async () =>
      writes[0].answer.reject(new ConvexError({ code: 'forbidden', message: 'not yours' })),
    )
    expect(editing()).not.toBeNull()
    expect(editor.getText()).toBe('Check 2 rerun')
    await click('Save')
    await act(async () => writes[1].answer.resolve(null))
    expect(editing()).toBeNull()
    expect(thread()).toEqual(['Check 1', 'Check 2 rerun', 'Check 3'])
  })

  it('turns Comment and Save off while the text is over its limit', async () => {
    await load()
    await open()
    await act(async () => deliver({ comments: range(1, 4), earlier: false }))
    const cases: [string, string, number][] = [
      ['Leave a comment', 'Comment', LIMITS.comment.max],
      ['Task description', 'Save', LIMITS.description.max],
    ]
    for (const [label, submit, max] of cases) {
      const editor = await editorOf(label)
      await act(async () => editor.commands.insertContent('a'.repeat(max + 1)))
      // the count follows once typing rests
      await vi.waitFor(() => expect(button(submit).disabled, label).toBe(true))
      expect(document.querySelector('[data-limit-count]')?.getAttribute('data-limit-count')).toBe(
        'over',
      )
      await act(async () => editor.commands.setContent('a'.repeat(max)))
      await vi.waitFor(() => expect(button(submit).disabled, label).toBe(false))
      // nothing goes out on the way
      expect(writes).toEqual([])
      await act(async () => editor.commands.setContent(''))
    }
  })
})

describe('a description saved before the text limit', { timeout: 20_000 }, () => {
  it('opens read-only, so the parser fallback is never saved back', async () => {
    await load(`# Heading\n\n${'a'.repeat(LIMITS.description.max)}`)
    await open()
    expect(document.body.textContent).toContain('This description is too long to edit.')
    expect(document.querySelector('[aria-label="Task description"]')).toBeNull()
  })
})

describe('a failed thread in the task window', { timeout: 20_000 }, () => {
  it('says the comments could not load, with Retry, instead of an empty thread', async () => {
    await load()
    await open()
    await act(async () => fail(new Error('Server Error')))
    expect(failure()?.textContent).toBe("Couldn't load comments.Retry")
    expect(spineText()).not.toContain('No comments yet.')
    expect(spineText()).not.toContain('Loading comments…')
    await click('Retry')
    expect(subscriptions).toBe(2)
    expect(failure()?.textContent).toBe('Loading comments…')
    // the old failure the client hands the new subscription is not its answer
    await later()
    expect(failure()?.textContent).toBe('Loading comments…')
    await act(async () => deliver({ comments: range(1, 4), earlier: false }))
    expect(failure()).toBeNull()
    expect(thread()).toEqual(['Check 1', 'Check 2', 'Check 3'])
  })

  it('keeps the comments on screen when the thread fails later', async () => {
    await load()
    await open()
    await act(async () => deliver({ comments: range(1, 4), earlier: false }))
    await act(async () => fail(new Error('Server Error')))
    expect(thread()).toEqual(['Check 1', 'Check 2', 'Check 3'])
    expect(failure()?.textContent).toBe("Couldn't load the latest comments.Retry")
  })

  it('shows an empty thread for a task that is gone or hidden', async () => {
    await load()
    await open()
    await act(async () => fail(new ConvexError({ code: 'not_found', message: 'task not found' })))
    expect(failure()).toBeNull()
    expect(spineText()).toContain('No comments yet.')
  })
})
