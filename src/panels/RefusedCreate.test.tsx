// @vitest-environment jsdom
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture } from '../store/plannerFixture.setup'

/* A new task's window when the server refuses the create, on the real
   store, the real editors and App's own create and refusal wiring: the task
   is made through the project's New task button and the dialog. */

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
let toast: MockInstance

beforeEach(() => {
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.spyOn(console, 'error').mockImplementation(() => {})
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  history.replaceState(null, '', '/')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Waits for `find` to answer, through lazy modules that can take seconds
    to load on a busy worker. */
function waitFor<T>(find: () => T | null | undefined, what: string) {
  return vi.waitFor(
    () => {
      const found = find()
      if (!found) throw new Error(`missing ${what}`)
      return found
    },
    { timeout: 10_000 },
  )
}

/** The editor labelled `label`, once its lazy module has loaded. */
const editorOf = (label: string) =>
  waitFor(
    () =>
      document.querySelector<TiptapEditorHTMLElement>(`[role="textbox"][aria-label="${label}"]`)
        ?.editor,
    `the ${label} editor`,
  )

/** Renders App on the fixture, creates a task from the project's New task
    button and answers its key once the task's window shows. The server
    leaves the create unanswered until `refused`. */
async function openNewTask() {
  vi.resetModules()
  const snap = plannerFixture()
  // App opens on a project the person leads, which offers New task
  const base = snap.projects[0]
  snap.projects = [
    { ...base, id: 'plan', type: 'meta', key: 'PLAN', name: 'Plan', lead_id: snap.profiles[0].id },
    { ...base, id: 'work', key: 'WORK', num: 2, name: 'Work', parent_id: 'plan' },
  ]
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
  // App's views load their code only while the socket counts as connected
  const { syncStatus } = await import('../lib/syncStatus')
  syncStatus.setSocket({ connected: true, everConnected: true })
  const { default: App } = await import('../App')
  const { DiscardPrompt } = await import('../components/DiscardPrompt')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <App />
        <DiscardPrompt />
      </TooltipProvider>,
    ),
  )
  // App shows its toasts through the window.showToast it installs
  toast = vi.spyOn(window as { showToast: NonNullable<typeof window.showToast> }, 'showToast')
  const add = await waitFor(
    () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'New task'),
    'the New task button',
  )
  await act(async () => add.click())
  const title = await waitFor(
    () => document.querySelector<HTMLInputElement>('input[aria-label="Title"]'),
    'the Title field',
  )
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    set?.call(title, 'Run the soak test')
    title.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const create = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Create')
  await act(async () => create?.click())
  const task = store.P.issues.find((it) => it.title === 'Run the soak test')
  if (!task) throw new Error('the task was not created')
  return task.key
}

/** Refuses the create and lets the window close. */
const refused = () =>
  act(async () => {
    refuse(new ConvexError({ code: 'forbidden', message: 'no write access to this project' }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
const toasts = () => toast.mock.calls.map(([text]) => text)

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
      `Created ${key}`,
      "You don't have permission for that. Change reverted.",
      `${key} was not created, so its window closed and your unsent comment and description went with it.`,
    ])
  })

  it('says only the refusal when nothing was typed', async () => {
    const key = await openNewTask()
    await editorOf('Leave a comment')
    await refused()
    expect(document.querySelector('[role="textbox"]')).toBeNull()
    expect(toasts()).toEqual([
      `Created ${key}`,
      "You don't have permission for that. Change reverted.",
    ])
  })
})
