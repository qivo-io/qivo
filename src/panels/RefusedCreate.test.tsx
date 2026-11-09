// @vitest-environment jsdom
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { type BoardArgs, boardStandIn } from '../store/boardStandIn.setup'
import { answerOverview } from '../store/overviewStandIn.setup'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'
import {
  answerProjectNav,
  isProjectNavRead,
  projectNavStandIn,
} from '../store/projectNavStandIn.setup'

/* A new task's window when the server refuses the create, on the real
   store, the real editors and App's own create and refusal wiring: the task
   is made through the project's New task button and the dialog, in a store
   that never asked for every task, as the app boots, so the window shows
   it from its creating answer and App names it by its key, never by the
   reference it opened it by. */

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

let container: HTMLDivElement
let root: Root
let refuse: (error: unknown) => void
/* Refuses the comment the window posted, which went out behind the create. */
let refuseComment: (error: unknown) => void
let toast: MockInstance
/* Answers each open Board read again from the server's tasks with `more`
   added, as after a write the server stored. */
let answerBoards: (more: Snapshot['issues']) => void

beforeEach(() => {
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  // the Overview's panels read their animations while it loads
  Element.prototype.getAnimations = () => []
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

/** Renders App on the fixture, at `path` when given and else at Plan's
    Overview, creates a task from the project's New task button and answers
    its key once the task's window shows. The server leaves the create
    unanswered until `refused`. */
async function openNewTask(path = '/app/testbed/overview/p/1') {
  vi.resetModules()
  history.replaceState(null, '', path)
  const snap = plannerFixture()
  // App opens on a project the person leads, which offers New task
  const base = snap.projects[0]
  snap.projects = [
    { ...base, id: 'plan', type: 'meta', key: 'PLAN', name: 'Plan', lead_id: snap.profiles[0].id },
    { ...base, id: 'work', key: 'WORK', num: 2, name: 'Work', parent_id: 'plan' },
  ]
  const boards = new Set<{ args: BoardArgs; next: (value: unknown) => void }>()
  answerBoards = (more) => {
    for (const read of boards)
      read.next(boardStandIn({ ...snap, issues: [...snap.issues, ...more] }, read.args))
  }
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    else if (name === 'tasks:board') {
      const read = { args: args as BoardArgs, next }
      boards.add(read)
      next(boardStandIn(snap, read.args))
      return () => boards.delete(read)
    }
    // the Overview's empty note, with New task, waits for its answer
    else if (name.startsWith('overview:')) answerOverview(snap, name, args, next, fail)
    // the navigation reads the New task picker lists from, as the server
    // answers them
    else if (isProjectNavRead(name)) answerProjectNav(snap, name, args, next, fail)
    return () => {}
  })
  // a numbered project address resolves through projectNav.resolve
  network.query.mockImplementation(async (ref, args) =>
    getFunctionName(ref) === 'projectNav:resolve'
      ? projectNavStandIn(snap, 'projectNav:resolve', args)
      : null,
  )
  network.mutation.mockImplementation((ref) => {
    const name = getFunctionName(ref)
    if (name === 'issues:create')
      return new Promise((_resolve, reject) => {
        refuse = reject
      })
    return name.startsWith('comments:')
      ? new Promise((_resolve, reject) => {
          refuseComment = reject
        })
      : Promise.resolve(null)
  })
  // the app's boot, without every task
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
  // the key the new task takes, which the dialog's create previews
  // the fixture's organization has handed out no task number yet
  const key = `${store.P.ISSUE_PREFIX}-1`
  const create = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Create')
  await act(async () => create?.click())
  await waitFor(
    () => document.querySelector('[data-task-title]')?.textContent?.includes('Run the soak test'),
    'the new task in its window',
  )
  // the window names it by its key, though App opened it by a reference
  expect(document.querySelector('[data-issue-key]')?.textContent).toBe(key)
  return key
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

  it('says nothing more for a comment posted before the refusal, whose write the server refuses after it', async () => {
    const key = await openNewTask()
    const composer = await editorOf('Leave a comment')
    await act(async () => composer.commands.insertContent('Drift is under 2%'))
    const post = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Comment',
    )
    await act(async () => post?.click())
    await refused()
    // the comment went out behind the create, so the server refuses it
    // after the create, for a task that never existed
    await act(async () => {
      refuseComment(new ConvexError({ code: 'not_found', message: 'issue not found' }))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(document.querySelector('[role="textbox"]')).toBeNull()
    expect(toasts()).toEqual([
      `Created ${key}`,
      "You don't have permission for that. Change reverted.",
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

  it('closes its window when the refusal names the number its task moved to before App took the move', async () => {
    const key = await openNewTask('/app/testbed/board/p/2')
    await editorOf('Leave a comment')
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    // another create took the preview number first. The Board's answer
    // brings that task, which moves the new task's reference past it, and
    // the refusal arrives before App renders the move
    const { P } = await import('../store/planner')
    const org = P.orgs[0]?.id ?? ''
    const at = '2026-09-14T09:00:00.000Z'
    await act(async () => {
      answerBoards([
        {
          id: crypto.randomUUID(),
          org_id: org,
          project_id: 'work',
          num: Number(key.slice(key.indexOf('-') + 1)),
          title: 'Check the soak rig',
          description: '',
          status: 'todo',
          priority: 'medium',
          paused: false,
          status_at: at,
          created_at: at,
          updated_at: at,
          has_hidden_subtasks: false,
          has_hidden_parent: false,
        },
      ])
      refuse(new ConvexError({ code: 'forbidden', message: 'no write access to this project' }))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(toasts()).toEqual([
      `Created ${key}`,
      "You don't have permission for that. Change reverted.",
    ])
  })
})
