// @vitest-environment jsdom
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The keys of the task window, on the real store and the real editor. The
   app has no shortcuts of its own there: L opens no label picker and
   Ctrl+S or Cmd+S saves no draft, so each stays the browser's. Esc, the
   editor's formatting keys and the visible buttons keep working. Every
   write succeeds. */

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

type Planner = typeof import('../store/planner')['P']
type Detail = typeof import('./IssueDetail')

const NOW = '2026-09-14T08:00:00.000Z'

let P: Planner
let detail: Detail
let container: HTMLDivElement
let root: Root

/** Loads the store with task QN-27, whose description is `description`. */
async function load(description = '') {
  vi.resetModules()
  const snap: Snapshot = plannerFixture()
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
    created_at: NOW,
    updated_at: NOW,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  network.onUpdate.mockImplementation((ref, _args, next) => {
    if (getFunctionName(ref) === 'workspace:whole') next(structuredClone(snap))
    return () => {}
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockReset().mockResolvedValue(null)
  const store = await import('../store/planner')
  P = store.P
  await store.initStore()
  detail = await import('./IssueDetail')
}

beforeEach(() => {
  // jsdom lays nothing out. ProseMirror measures a Range to scroll the caret
  // into view.
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  // nor scrolls: a picker brings its section heading into view first
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  // the label picker follows its own size
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
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

/* Opens the task window on QN-27. */
async function open(onClose = vi.fn()) {
  const task = P.issues.find((it) => it.uuid === 'task-a')
  if (!task) throw new Error('missing the task')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <detail.IssueDetail issueId={task.id} onClose={onClose} onOpen={vi.fn()} />
      </TooltipProvider>,
    ),
  )
}

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
  const found = [...document.querySelectorAll('button')].find(
    (b) => b.textContent === name || b.getAttribute('aria-label') === name,
  )
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing ${name}`)
  return found
}
/* Presses `key` on `target`. True when the app took it from the browser. */
async function press(target: EventTarget, key: string, mods: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })
  await act(async () => target.dispatchEvent(event))
  return event.defaultPrevented
}
/* Lets the next animation frame run, where a picker measures its place. */
const nextFrame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
const labelPicker = () => document.querySelector('input[placeholder="Add labels…"]')
/* The descriptions and comments sent to the server, in order. */
const saved = () =>
  network.mutation.mock.calls.flatMap(([ref, args]) => {
    const name = getFunctionName(ref)
    if (name === 'issues:update' && 'description' in args.patch) return [args.patch.description]
    if (name === 'comments:create') return [args.body]
    return []
  })

// Each test imports the whole task window afresh, which takes seconds on a
// busy CI worker.
describe('keys in the task window', { timeout: 20_000 }, () => {
  it('opens no label picker on L, and Add label opens it', async () => {
    await load()
    await open()
    const frame = document.querySelector('[aria-label="Task"]')
    if (!frame) throw new Error('missing the task window')
    for (const target of [document.body, frame]) {
      expect(await press(target, 'l')).toBe(false)
      expect(await press(target, 'L', { shiftKey: true })).toBe(false)
    }
    await nextFrame()
    await nextFrame()
    expect(labelPicker()).toBeNull()
    await act(async () => button('Add label').click())
    await nextFrame()
    expect(labelPicker()).not.toBeNull()
    // and its search row names no key
    expect(labelPicker()?.parentElement?.textContent).toBe('')
  })

  it('saves no description on Ctrl+S or Cmd+S, and Save saves the kept draft', async () => {
    await load('Soak for 48 hours')
    await open()
    const editor = await editorOf('Task description')
    await act(async () => editor.chain().focus('end').insertContent(' at 40 C').run())
    expect(await press(editor.view.dom, 's', { ctrlKey: true })).toBe(false)
    expect(await press(editor.view.dom, 's', { metaKey: true })).toBe(false)
    expect(saved()).toEqual([])
    expect(editor.getText()).toBe('Soak for 48 hours at 40 C')
    await act(async () => button('Save').click())
    expect(saved()).toEqual(['Soak for 48 hours at 40 C'])
  })

  it('posts no comment on Ctrl+S or Cmd+S, and Comment posts the kept draft', async () => {
    await load()
    await open()
    const composer = await editorOf('Leave a comment')
    await act(async () => composer.chain().focus().insertContent('Soak run finished').run())
    expect(await press(composer.view.dom, 's', { ctrlKey: true })).toBe(false)
    expect(await press(composer.view.dom, 's', { metaKey: true })).toBe(false)
    expect(saved()).toEqual([])
    expect(composer.getText()).toBe('Soak run finished')
    await act(async () => button('Comment').click())
    expect(saved()).toEqual(['Soak run finished'])
  })

  it('bolds the selected text on Ctrl+B', async () => {
    await load('Soak for 48 hours')
    await open()
    const editor = await editorOf('Task description')
    await act(async () => editor.chain().focus().selectAll().run())
    expect(await press(editor.view.dom, 'b', { ctrlKey: true })).toBe(true)
    expect(editor.getHTML()).toContain('<strong>Soak for 48 hours</strong>')
  })

  it('closes on Esc', async () => {
    await load()
    const onClose = vi.fn()
    await open(onClose)
    await press(document.body, 'Escape')
    expect(onClose).toHaveBeenCalled()
  })
})
