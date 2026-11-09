// @vitest-environment jsdom
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { pastCloseTicks } from './lib/discardQuestion.setup'
import { type BoardArgs, boardStandIn } from './store/boardStandIn.setup'
import { plannerFixture, type Snapshot } from './store/plannerFixture.setup'
import {
  answerProjectNav,
  isProjectNavRead,
  queryProjectNav,
} from './store/projectNavStandIn.setup'

/* The task window a Settings › Archived tasks row opens, over Settings,
   in the whole App on the real store. The server holds two archived tasks
   in Firmware, a sub-project of the project the person leads:
   issues.archivedPage lists them, the
   window's own read (taskWindow:task) answers them archived, and a restore
   (issues:unarchive) moves one back into the workspace and delivers it. The
   project picker reads the navigation reads from their stand-in, and the
   Board, where Show on board leads, reads tasks.board from its stand-in
   over the workspace. Writes other than the restore never answer. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('./lib/convex', async () => {
  const { liveOver } = await import('./store/guard/liveDouble.setup')
  return { convex: network, live: liveOver(network, { taskWindow: 'client' }) }
})
vi.mock('./lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const AT = '2026-09-14T08:00:00.000Z'

type Task = Snapshot['issues'][number]
let container: HTMLDivElement
let root: Root
let snap: Snapshot
let archive: Task[]
let deliver: (next: Snapshot) => void
let PROJECT: string
let ORG: string

/** An archived task of the project, number `num`. */
const archived = (num: number, title: string): Task => ({
  id: `arch-${num}`,
  org_id: ORG,
  project_id: PROJECT,
  num,
  title,
  description: `The notes of ${title}.`,
  status: 'done',
  priority: 'medium',
  paused: false,
  created_at: AT,
  updated_at: AT,
  has_hidden_subtasks: false,
  has_hidden_parent: false,
})

/** What the window's read of task `ref` answers: the active task, the
    archived one with its text, or unavailable. */
function readAnswer(ref: string): unknown {
  const live = snap.issues.find((task) => task.id === ref)
  if (live)
    return {
      state: 'ok',
      task: live,
      level: 'lead',
      labels: [],
      follow: null,
      parent: null,
      subtasks: { rows: [], complete: true },
    }
  const gone = archive.find((task) => task.id === ref)
  if (!gone) return { state: 'unavailable' }
  const { description, parent_id: _parent, ...row } = gone
  return {
    state: 'archived',
    task: { ...row, is_group: false },
    description,
    labels: [],
    level: 'lead',
  }
}

/** Boots App on the workspace with the project the person leads, its
    sub-project Firmware and two archived tasks there, and goes to
    Archived tasks. */
async function boot() {
  vi.resetModules()
  snap = plannerFixture()
  ORG = snap.orgs[0].id
  const meta = { ...snap.projects[0], type: 'meta' as const, lead_id: snap.profiles[0].id }
  PROJECT = crypto.randomUUID()
  snap.projects = [
    meta,
    {
      ...meta,
      id: PROJECT,
      type: 'project',
      parent_id: meta.id,
      key: 'FW',
      num: 2,
      name: 'Firmware',
      lead_id: undefined,
    },
  ]
  archive = [archived(41, 'Calibrate the old rig'), archived(42, 'Measure the drift')]
  const reads: { args: { ref: string }; next: (value: unknown) => void }[] = []
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      deliver = (value) => {
        snap = value
        next(structuredClone(value))
        for (const read of reads) read.next(readAnswer(read.args.ref))
      }
      next(structuredClone(snap))
    } else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    else if (name === 'taskWindow:task') {
      const read = { args, next }
      reads.push(read)
      setTimeout(() => next(readAnswer(args.ref)), 0)
    } else if (isProjectNavRead(name)) answerProjectNav(snap, name, args, next, fail)
    else if (name === 'tasks:board') next(boardStandIn(snap, args as BoardArgs))
    return () => {}
  })
  network.query.mockImplementation(async (ref, args) => {
    const name = getFunctionName(ref)
    if (isProjectNavRead(name)) return queryProjectNav(snap, name, args)
    if (name !== 'issues:archivedPage') return null
    return {
      rows: archive.map((task) => ({
        ...task,
        archived_at: '2026-09-15T08:00:00.000Z',
        is_group: false,
        place: { project_name: 'Firmware', parent_name: snap.projects[0].name },
        owner_name: null,
        can_restore: true,
      })),
      next_cursor: null,
      scanned: archive.length,
    }
  })
  network.mutation.mockImplementation(async (ref, args) => {
    if (getFunctionName(ref) !== 'issues:unarchive') return null
    const task = archive.find((t) => t.id === args.id)
    if (task) {
      archive = archive.filter((t) => t !== task)
      const next = structuredClone(snap)
      next.issues.push(task)
      next.delivered_at = '2026-09-15T09:00:00.000Z'
      setTimeout(() => deliver(next), 0)
    }
    return { issue: { id: args.id }, left_parent: false }
  })
  const store = await import('./store/planner')
  await store.initStore()
  const { syncStatus } = await import('./lib/syncStatus')
  syncStatus.setSocket({ connected: true, everConnected: true })
  const { default: App } = await import('./App')
  // the question about unsent text, which main.tsx mounts beside App
  const { DiscardPrompt } = await import('./components/DiscardPrompt')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <App />
        <DiscardPrompt />
      </TooltipProvider>,
    ),
  )
  const org = location.pathname.split('/')[2]
  await act(async () => {
    history.pushState(null, '', `/app/${org}/settings/projects-archived-tasks`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await waitFor(() => document.querySelector('[data-archive-project]'), 'Archived tasks')
  // All projects of the one organization lists both tasks
  await click(find('[data-archive-project]'))
  await click(
    await waitFor(() => document.querySelector(`[data-project-pick-all="${ORG}"]`), 'All projects'),
  )
  await act(async () =>
    find('[data-project-picker-search]').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    ),
  )
  await waitFor(() => document.querySelector('[data-archive-row="arch-42"]'), 'the rows')
  // the closed picker gives focus back to its button in a task of its own,
  // which lands before a person's next press
  await waitFor(
    () => (document.activeElement === find('[data-archive-project]') ? true : null),
    "the picker's focus",
  )
  return { address: location.pathname }
}

beforeEach(() => {
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.scrollIntoView = () => {}
  // jsdom does not scroll, so a scroll to a place, as the Board's reveal
  // makes, sets the element's offset
  Element.prototype.scrollTo = function (this: Element, options?: ScrollToOptions | number) {
    if (typeof options === 'object') this.scrollTop = options.top ?? 0
  }
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

/** Waits for `find` to answer, through lazy modules. */
function waitFor<T>(look: () => T | null | undefined, what: string) {
  return vi.waitFor(
    () => {
      const found = look()
      if (!found) throw new Error(`missing ${what}`)
      return found
    },
    { timeout: 10_000 },
  )
}
function find<T extends Element = HTMLElement>(selector: string) {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}
async function click(element: Element) {
  if (!(element instanceof HTMLElement)) throw new Error('nothing to click')
  await act(async () => element.click())
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
}
/** Presses Escape as a person does, on what holds focus. */
const pressEscape = () =>
  act(async () => {
    ;(document.activeElement ?? document).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
const rowIds = () =>
  [...document.querySelectorAll<HTMLElement>('[data-archive-row]')].map(
    (el) => el.dataset.archiveRow,
  )
const archivedWindow = () => document.querySelector('[role="dialog"][data-task-archived]')

describe('an Archived tasks row', { timeout: 30_000 }, () => {
  it('opens its task read-only over Settings, and Escape closes the window alone', async () => {
    const { address } = await boot()
    const open = find('[data-archive-open="arch-41"]')
    open.focus()
    await click(open)
    const dialog = await waitFor(archivedWindow, 'the archived task window')
    // the window reads the task itself, with its notes
    await waitFor(
      () => (dialog.textContent?.includes('The notes of Calibrate the old rig.') ? dialog : null),
      'the notes',
    )
    // the address stays the Settings page's
    expect(location.pathname).toBe(address)
    expect(document.querySelector('[data-settings-page="projects-archived-tasks"]')).not.toBeNull()
    await pressEscape()
    await waitFor(() => (archivedWindow() ? null : true), 'the window to close')
    expect(document.querySelector('[data-settings-page="projects-archived-tasks"]')).not.toBeNull()
    expect(location.pathname).toBe(address)
    // focus is back on the row's open button
    expect(document.activeElement).toBe(find('[data-archive-open="arch-41"]'))
    expect(rowIds()).toEqual(['arch-41', 'arch-42'])
  })

  it('drops the row once the window that restored its task closes', async () => {
    await boot()
    const asked = network.query.mock.calls.filter(
      ([ref]) => getFunctionName(ref) === 'issues:archivedPage',
    ).length
    await click(find('[data-archive-open="arch-42"]'))
    const dialog = await waitFor(archivedWindow, 'the archived task window')
    const restore = [...dialog.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Restore',
    )
    if (!restore) throw new Error('no Restore in the window')
    await click(restore)
    await waitFor(() => (archivedWindow() ? null : true), 'the restored task shown active')
    expect(network.mutation).toHaveBeenCalledWith(expect.anything(), { org_id: ORG, id: 'arch-42' })
    await pressEscape()
    await waitFor(
      () => (document.querySelector('[role="dialog"]') ? null : true),
      'the window to close',
    )
    // the page read its page again, which no longer lists the task
    await waitFor(() => (rowIds().length === 1 ? true : null), 'the page read again')
    expect(rowIds()).toEqual(['arch-41'])
    expect(
      network.query.mock.calls.filter(([ref]) => getFunctionName(ref) === 'issues:archivedPage'),
    ).toHaveLength(asked + 1)
  })

  it('leaves Settings for the board with the task revealed when Show on board acts', async () => {
    const { address } = await boot()
    await click(find('[data-archive-open="arch-42"]'))
    const dialog = await waitFor(archivedWindow, 'the archived task window')
    const restore = [...dialog.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Restore',
    )
    if (!restore) throw new Error('no Restore in the window')
    await click(restore)
    // restored, the window names the task's project, which shows it on the board
    const crumb = await waitFor(
      () =>
        archivedWindow()
          ? null
          : document.querySelector(`[role="dialog"] [data-task-crumb-project="${PROJECT}"]`),
      'the project in the restored task',
    )
    await click(crumb)
    await waitFor(
      () => (document.querySelector('[data-settings-page]') ? null : true),
      'Settings to close',
    )
    // the window over Settings went with it, and the board of the task's
    // project shows its card revealed, with the task's own window over it
    expect(location.pathname).toBe(`/app/${address.split('/')[2]}/board/tasks/qn-42`)
    // the ring is on the card that holds the task's row
    await waitFor(
      () => document.querySelector('[data-card="QN-42"]')?.closest('[data-board-revealed]'),
      'the revealed card',
    )
    const windows = document.querySelectorAll('[role="dialog"]')
    expect(windows).toHaveLength(1)
    expect(windows[0].hasAttribute('data-task-archived')).toBe(false)
    expect(windows[0].textContent).toContain('Measure the drift')
  })

  it('keeps Settings and the window where Plan on roadmap only says why', async () => {
    const { address } = await boot()
    // the task comes back in Backlog, which the roadmap does not plan
    archive = archive.map((t) => (t.id === 'arch-42' ? { ...t, status: 'backlog' as const } : t))
    await click(find('[data-archive-open="arch-42"]'))
    const dialog = await waitFor(archivedWindow, 'the archived task window')
    const restore = [...dialog.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Restore',
    )
    if (!restore) throw new Error('no Restore in the window')
    await click(restore)
    const plan = await waitFor(
      () =>
        archivedWindow()
          ? null
          : document.querySelector<HTMLButtonElement>(
              '[role="dialog"] [data-plan-on-roadmap]:not(:disabled)',
            ),
      'Plan on roadmap in the restored task',
    )
    await click(plan)
    await waitFor(
      () =>
        document.body.textContent?.includes(
          'Move this task out of Backlog before planning it on the roadmap',
        )
          ? true
          : null,
      'the Backlog toast',
    )
    // the toast shows over Settings, and nothing closed
    expect(document.querySelector('[data-settings-page="projects-archived-tasks"]')).not.toBeNull()
    expect(document.querySelector('[role="dialog"] [data-plan-on-roadmap]')).not.toBeNull()
    expect(location.pathname).toBe(address)
  })

  it('asks before a close of the window throws away a comment typed in it', async () => {
    await boot()
    await click(find('[data-archive-open="arch-42"]'))
    const dialog = await waitFor(archivedWindow, 'the archived task window')
    const restore = [...dialog.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Restore',
    )
    if (!restore) throw new Error('no Restore in the window')
    await click(restore)
    // restored, the window shows the task with its comment box
    const composer = await vi.waitFor(
      () => {
        const found = document.querySelector<TiptapEditorHTMLElement>(
          '[role="textbox"][aria-label="Leave a comment"]',
        )?.editor
        if (!found) throw new Error('missing the comment editor')
        return found
      },
      { timeout: 10_000 },
    )
    await act(async () => composer.commands.insertContent('Drift is under 2%'))
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await pastCloseTicks()
    })
    await act(() =>
      vi.waitFor(
        () =>
          expect(document.querySelector('[data-discard-prompt] h2')?.textContent).toBe(
            'Discard your unsent comment?',
          ),
        { timeout: 5_000 },
      ),
    )
    // the window and Settings both stay while the question is open
    expect(document.querySelector('[role="dialog"] [aria-label="Leave a comment"]')).not.toBeNull()
    expect(document.querySelector('[data-settings-page="projects-archived-tasks"]')).not.toBeNull()
  })
})
