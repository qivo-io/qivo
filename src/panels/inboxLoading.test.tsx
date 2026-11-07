// @vitest-environment jsdom
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../../convex/lib/limits'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot, underProgram } from '../store/plannerFixture.setup'

/* An Inbox item whose task the workspace does not hold, while every task
   loads (store/liveParts.ts) or in a session that never asked for them:
   picking it opens its task in the pane from the server, by a reference
   with the row's organization, number and uuid (lib/taskReference.ts),
   whose window reads the task's inbox item, and the pane's window
   stays the same window when the task arrives, or the home organization
   changes. The pane edits, moves and takes images for a task it shows
   from its answer, names an archived one by its key, and offers Open
   task in board for it, as the row's menu does, since the store holds
   its project. The Inbox's search goes to the server and asks for no
   task. Back or Forward to
   such a task (App pendingTask) shows the pane that says it loads, on a
   phone too, and Escape closes a pop-out, then the pane. A related task the workspace does not hold,
   opened from the pop-out, keeps both windows. The pop-out over a task the
   pane shows from its answer offers the relation pickers, which read the
   server. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | { holdWindow(from: string | null): void },
}))
vi.mock('../lib/convex', async () => {
  const { liveOver } = await import('../store/guard/liveDouble.setup')
  double.live = liveOver(network)
  return { convex: network, live: double.live }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const AT = '2026-09-14T08:00:00.000Z'
// 12,800 task numbers make 64 task windows; the last starts at fc000000
const LAST_WINDOW = 'fc000000'

let container: HTMLDivElement
let root: Root
/* The task window's reads of a task (taskWindow.task), which a test answers. */
let windowReads: { args: Record<string, unknown>; next: (value: unknown) => void }[]
/* The reads of a task's comments, which a test answers. */
let threadReads: ((value: unknown) => void)[]

beforeEach(() => {
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
  double.live?.holdWindow(null)
  container.remove()
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Loads a large workspace whose last task window, holding task QN-2 and
    its Inbox item, is still to arrive, and renders the Inbox as App holds
    it, the pane showing the task the address names, `address` at first.
    `edit` changes the fixture first. Answers the store, the fixture, the
    tasks the Inbox opened, its exits, its reads, a way to move the address
    as Back or Forward would and one to publish a changed workspace. */
async function loadingInbox(
  address: ((org: string) => string) | null = null,
  edit?: (snap: Snapshot) => void,
) {
  vi.resetModules()
  windowReads = []
  threadReads = []
  const snap: Snapshot = plannerFixture()
  snap.orgs[0].next_issue_num = 64 * 200
  snap.issues.push({
    id: 'fd000000-b',
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
    num: 2,
    title: 'Run the soak test',
    description: '',
    status: 'progress',
    priority: 'medium',
    paused: false,
    created_at: AT,
    updated_at: AT,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  // a task in the first task window, which answers, with its own item
  snap.issues.push({
    id: '00000000-a',
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
    num: 1,
    title: 'Write the load plan',
    description: '',
    status: 'todo',
    priority: 'medium',
    paused: false,
    created_at: AT,
    updated_at: AT,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  snap.messages.push({
    id: 'message-b',
    org_id: snap.orgs[0].id,
    recipient_id: snap.profiles[0].id,
    issue_id: '00000000-a',
    issue_title: 'Write the load plan',
    kind: 'comment',
    detail: 'New comment',
    created_at: '2026-09-14T08:30:00.000Z',
  })
  snap.messages.push({
    id: 'message-a',
    org_id: snap.orgs[0].id,
    recipient_id: snap.profiles[0].id,
    issue_id: 'fd000000-b',
    issue_title: 'Run the soak test',
    kind: 'comment',
    detail: 'New comment',
    created_at: '2026-09-14T09:00:00.000Z',
  })
  edit?.(snap)
  let whole: (value: Snapshot) => void = () => {}
  network.onUpdate.mockImplementation((ref, args, next) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      whole = next
      next(structuredClone(snap))
    } else if (name === 'taskWindow:task') windowReads.push({ args, next })
    else if (name === 'snapshot:threadComments') threadReads.push(next)
    return () => {}
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  const reads = () =>
    network.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === 'messages:readItem')
  const store = await import('../store/planner')
  double.live?.holdWindow(LAST_WINDOW)
  await store.initStore()
  expect(store.P.stillLoading()).not.toBeNull()
  const { Inbox } = await import('./Inbox')
  const { usePlannerVersion } = await import('../store/usePlannerVersion')
  const opened: (string | null)[] = []
  const onExit = vi.fn()
  const go = { to: (_handle: string | null) => {} }
  // the task the pane shows now
  const shown = { open: null as string | null }
  /** The Inbox as App holds it: the task the pane shows is the address's,
      which follows its task's handle as it moves (P.watchHandles). */
  function Host() {
    usePlannerVersion()
    const [openIssue, setOpenIssue] = useState<string | null>(
      address ? address(snap.orgs[0].id) : null,
    )
    useEffect(() => {
      shown.open = openIssue
    }, [openIssue])
    useEffect(() => {
      go.to = setOpenIssue
      return store.P.watchHandles((moved) => setOpenIssue((cur) => (cur && moved.get(cur)) || cur))
    }, [])
    return (
      <Inbox
        showOnBoard={vi.fn()}
        onExit={onExit}
        openTask={(handle: string | null) => {
          opened.push(handle)
          setOpenIssue(handle)
        }}
        openIssue={openIssue}
        onPlanOnRoadmap={vi.fn()}
      />
    )
  }
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Host />
      </TooltipProvider>,
    ),
  )
  const goTo = (handle: string | null) => act(async () => go.to(handle))
  const publish = () =>
    act(async () => {
      whole(structuredClone(snap))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  return { store, snap, opened, onExit, reads, goTo, publish, current: () => shown.open }
}

/** Lets the last task window answer. */
const arrive = () =>
  act(async () => {
    double.live?.holdWindow(null)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

/* The task answer of fd000000-b, QN-2 (convex/lib/taskWindow.ts), with
   `subtasks`. */
const answerOf = (snap: Snapshot, subtasks: unknown[] = []) => {
  const row = snap.issues.find((it) => it.id === 'fd000000-b')
  return {
    state: 'ok',
    task: { ...row, has_subtasks: subtasks.length > 0 },
    level: 'user',
    labels: [],
    follow: null,
    parent: null,
    subtasks: { rows: subtasks, complete: true },
  }
}
/* The pane's window. */
const paneWindow = () => container.querySelector<HTMLElement>('.inbox-detail-frame [role="region"]')
/* The editor labelled `label`, once it shows. */
const editorOf = (label: string) =>
  vi.waitFor(() => {
    const found = document.querySelector<TiptapEditorHTMLElement>(
      `[role="textbox"][aria-label="${label}"]`,
    )?.editor
    if (!found) throw new Error(`missing the ${label} editor`)
    return found
  })
/* The writes of mutation `name` the store sent, their arguments in order. */
const sentArgs = (name: string) =>
  network.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === name)
    .map(([, args]) => args as Record<string, unknown>)
/* The button that reads `text` inside `scope`. */
const buttonNamed = (text: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)
/* Types `value` into a field as a person does, which React hears. */
const typeInto = (
  field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set?.call(field, value)
    field.dispatchEvent(
      new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    )
  })
/* Opens the pane's Task actions menu, once the frames that move focus
   have run, and answers its items by their text. */
async function paneActions() {
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  await act(async () =>
    paneWindow()?.querySelector<HTMLElement>('[aria-label="Task actions"]')?.click(),
  )
  return (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes(text),
    )
}

describe('an Inbox item whose task is still to arrive', { timeout: 20_000 }, () => {
  it('opens its task in the pane from the server when picked, reads its inbox item, and keeps the same window once it arrives', async () => {
    const { store, snap, opened, reads, current } = await loadingInbox()
    const open = container.querySelector<HTMLButtonElement>(
      '[data-message="fd000000-b"] .inbox-message-open',
    )
    await act(async () => open?.click())
    const org = snap.orgs[0].id
    // the pane's window reads the task's whole item once the item answers
    await vi.waitFor(() =>
      expect(reads().map(([, args]) => args)).toEqual([
        { org_id: org, issue_id: 'fd000000-b', through: Date.parse('2026-09-14T09:00:00.000Z') },
      ]),
    )
    // by a reference with the row's organization, number and uuid
    const { refParts } = await import('../lib/taskReference')
    expect(refParts(opened.at(-1))).toEqual({ org, num: 2, uuid: 'fd000000-b' })
    expect(container.querySelector('[data-task-loading]')?.textContent).toContain('Loading QN-2…')
    expect(windowReads.map((read) => read.args)).toEqual([{ org_id: org, ref: 'fd000000-b' }])
    await act(async () => windowReads[0]?.next(answerOf(snap)))
    await vi.waitFor(() => expect(paneWindow()?.textContent).toContain('Run the soak test'))
    expect(paneWindow()?.dataset.taskSource).toBe('answer')
    const pane = paneWindow()
    // the reference turns into the task's handle as the task arrives, and
    // the pane's window stays
    await arrive()
    expect(store.P.stillLoading()).toBeNull()
    expect(current()).toBe(store.P.handleOf('fd000000-b'))
    expect(paneWindow()).toBe(pane)
    expect(paneWindow()?.dataset.taskSource).toBe('workspace')
  })

  it('offers Open task in board only once the workspace holds the task', async () => {
    const { snap } = await loadingInbox()
    const open = container.querySelector<HTMLButtonElement>(
      '[data-message="fd000000-b"] .inbox-message-open',
    )
    await act(async () => open?.click())
    await act(async () => windowReads[0]?.next(answerOf(snap)))
    await vi.waitFor(() => expect(paneWindow()?.dataset.taskSource).toBe('answer'))
    const shown = await paneActions()
    expect(shown('Copy link')).toBeDefined()
    expect(shown('Open task in board')).toBeUndefined()
    // the trigger closes the menu again
    await act(async () =>
      paneWindow()?.querySelector<HTMLElement>('[aria-label="Task actions"]')?.click(),
    )
    await arrive()
    expect(paneWindow()?.dataset.taskSource).toBe('workspace')
    const held = await paneActions()
    expect(held('Open task in board')).toBeDefined()
  })

  it("saves a field, takes no image past the server's cap and moves a task it shows from its answer", async () => {
    // the task's project and Bench under one top-level project
    const { snap } = await loadingInbox(null, (next) => {
      const [project] = underProgram(next).projects
      next.projects.push({ ...project, id: 'bench', key: 'BEN', num: 2, name: 'Bench' })
    })
    const open = container.querySelector<HTMLButtonElement>(
      '[data-message="fd000000-b"] .inbox-message-open',
    )
    await act(async () => open?.click())
    await act(async () => windowReads[0]?.next(answerOf(snap)))
    await vi.waitFor(() => expect(paneWindow()?.dataset.taskSource).toBe('answer'))
    const org = snap.orgs[0].id
    // the title, from the one it began from
    await act(async () => paneWindow()?.querySelector<HTMLElement>('[data-task-title]')?.click())
    const title = paneWindow()?.querySelector<HTMLTextAreaElement>('[aria-label="Task title"]')
    if (!title) throw new Error('the title field did not open')
    await typeInto(title, 'Run the soak test twice')
    await act(async () => title.blur())
    expect(sentArgs('issues:update').at(-1)).toMatchObject({
      org_id: org,
      id: 'fd000000-b',
      patch: { title: 'Run the soak test twice' },
    })
    // an image: the pane reads no attachments, so the server's cap refuses it
    network.mutation.mockImplementation((ref) =>
      getFunctionName(ref) === 'files:uploadUrl'
        ? Promise.reject(new ConvexError({ code: 'rule', message: LIMITS.attachments.refusal }))
        : Promise.resolve(null),
    )
    // the pane shows the description once it is opened
    await act(async () => paneWindow()?.querySelector<HTMLElement>('[data-desc-toggle]')?.click())
    const description = await editorOf('Task description')
    const image = new File(['png'], 'photo.png', { type: 'image/png' })
    await act(async () => {
      description.view.pasteHTML('', {
        clipboardData: { files: [image], getData: () => '' },
        preventDefault: () => {},
      } as unknown as ClipboardEvent)
    })
    await vi.waitFor(() => expect(sentArgs('files:uploadUrl')).toHaveLength(1))
    expect(sentArgs('files:uploadUrl')[0]).toEqual({
      org_id: org,
      issue_id: 'fd000000-b',
      size: 3,
      name: 'photo.png',
    })
    await vi.waitFor(() =>
      expect(window.showToast).toHaveBeenCalledWith(
        expect.stringContaining(
          'Couldn\'t upload "photo.png". This task already has 100 attachments',
        ),
        'error',
      ),
    )
    expect(sentArgs('files:attach')).toEqual([])
    // Move, to another sub-project of the same project
    const item = await paneActions()
    await act(async () => item('Move to sub-project…')?.click())
    const target = document.querySelector<HTMLSelectElement>('select[aria-label="Move to"]')
    if (!target) throw new Error('the Move window did not open')
    await typeInto(target, 'bench')
    await act(async () => buttonNamed('Move')?.click())
    // against the project the window showed
    expect(sentArgs('issues:move')).toEqual([
      {
        org_id: org,
        id: 'fd000000-b',
        project_id: 'bench',
        expected: { project_id: snap.projects[0].id },
      },
    ])
  })

  it('names an archived task it opens by its key, in its note and when Restore brings it back', async () => {
    const { snap } = await loadingInbox()
    network.mutation.mockImplementation(async (ref) =>
      getFunctionName(ref) === 'issues:unarchive' ? {} : null,
    )
    const open = container.querySelector<HTMLButtonElement>(
      '[data-message="fd000000-b"] .inbox-message-open',
    )
    await act(async () => open?.click())
    // the row names the task by its uuid alone, and the answer says archived
    const {
      description: _text,
      has_hidden_subtasks: _h,
      has_hidden_parent: _p,
      ...row
    } = snap.issues.find((it) => it.id === 'fd000000-b') ?? {}
    await act(async () =>
      windowReads[0]?.next({
        state: 'archived',
        task: { ...row, archived_at: '2026-09-14T09:30:00.000Z', is_group: false },
        description: '',
        labels: [],
        level: 'user',
      }),
    )
    // in the render the answer arrives in, the note names the task's key
    const note = paneWindow()?.querySelector('[data-task-gone] [role="status"]')
    expect(note?.textContent).toBe('QN-2 was archived. Restore it to bring it back to the board.')
    const restore = buttonNamed('Restore', paneWindow() ?? document)
    await act(async () => restore?.click())
    await vi.waitFor(() => expect(window.showToast).toHaveBeenCalledWith('Restored QN-2'))
  })

  it("keeps the pane's window and the comment typed in it when the home organization changes", async () => {
    const { store, snap, current, publish } = await loadingInbox()
    await arrive()
    const open = container.querySelector<HTMLButtonElement>(
      '[data-message="00000000-a"] .inbox-message-open',
    )
    await act(async () => open?.click())
    expect(current()).toBe('QN-1')
    await act(async () => threadReads.at(-1)?.({ comments: [], earlier: false }))
    const pane = paneWindow()
    expect(pane?.dataset.taskSource).toBe('workspace')
    const composer = await editorOf('Leave a comment')
    await act(async () => composer.commands.insertContent('Soak it twice'))
    // the person also holds a seat in Beta, which becomes the home organization
    const BETA = 'org-beta'
    const me = snap.profiles[0]
    snap.orgs.push({ ...snap.orgs[0], id: BETA, slug: 'beta', name: 'Beta', next_issue_num: 0 })
    snap.profiles.push({ ...me, id: 'me-beta', org_id: BETA })
    snap.myProfileIds.unshift('me-beta')
    await publish()
    expect(store.P.homeOrg).toBe(BETA)
    // the task's handle moves to its uuid, and the pane follows it
    expect(current()).toBe('00000000-a')
    expect(paneWindow()).toBe(pane)
    expect(composer.isDestroyed).toBe(false)
    expect((await editorOf('Leave a comment')).getText()).toBe('Soak it twice')
  })

  it('offers the relation pickers in the pop-out over a task it shows from its answer, read from the server', async () => {
    // a picker scrolls its section into view and follows its own size
    Element.prototype.scrollIntoView = () => {}
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    const { snap } = await loadingInbox()
    // the pickers' reads, which stay on their way
    const pickerReads: Record<string, unknown>[] = []
    network.query.mockImplementation((ref, args) => {
      if (getFunctionName(ref) !== 'taskWindow:relationCandidates') return Promise.resolve(null)
      pickerReads.push(args)
      return new Promise(() => {})
    })
    const open = container.querySelector<HTMLButtonElement>(
      '[data-message="fd000000-b"] .inbox-message-open',
    )
    await act(async () => open?.click())
    await act(async () => windowReads[0]?.next(answerOf(snap)))
    await vi.waitFor(() => expect(paneWindow()?.dataset.taskSource).toBe('answer'))
    const button = await vi.waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>('[data-task-popout]')
      if (!found) throw new Error('missing the pop-out button')
      return found
    })
    await act(async () => button.click())
    // the pop-out has the details column the pane has no room for
    const popOut = await vi.waitFor(() => {
      const windows = [...document.querySelectorAll<HTMLElement>('[aria-label="Task"]')]
      const found = windows.find((w) => w.dataset.issueLayout === 'columns')
      if (!found) throw new Error('missing the pop-out')
      return found
    })
    const control = (label: string) =>
      popOut.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    for (const label of ['Set parent', 'Add subtask', 'Link task'])
      expect(control(label)?.disabled, label).toBe(false)
    await act(async () => control('Link task')?.click())
    // the picker mounts a frame after the press, and reads once it has
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    await act(async () => {
      await vi.waitFor(() => expect(pickerReads).toHaveLength(1))
    })
    const org = snap.orgs[0].id
    expect(pickerReads).toEqual([{ org_id: org, issue_id: 'fd000000-b', kind: 'link' }])
    expect(document.querySelector('[data-relation-picker="link"]')).not.toBeNull()
  })

  it('keeps both windows when the pop-out opens a related task the workspace does not hold', async () => {
    const { store, snap } = await loadingInbox()
    const open = container.querySelector<HTMLButtonElement>(
      '[data-message="00000000-a"] .inbox-message-open',
    )
    await act(async () => open?.click())
    // the pane reads the row's task, which the workspace does not hold while
    // every task loads, with its subtask, one still to arrive
    const kid = snap.issues.find((it) => it.id === 'fd000000-b')
    const {
      description: _text,
      has_hidden_subtasks: _h,
      has_hidden_parent: _p,
      ...short
    } = kid ?? {}
    const row = snap.issues.find((it) => it.id === '00000000-a')
    const answer = {
      ...answerOf(snap),
      task: { ...row, has_subtasks: true },
      subtasks: {
        rows: [{ ...short, parent_id: '00000000-a', has_subtasks: false, level: 'user' }],
        complete: true,
      },
    }
    await vi.waitFor(() => expect(windowReads.length).toBeGreaterThan(0))
    await act(async () => windowReads.at(-1)?.next(answer))
    const popOut = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[data-task-popout]')
      if (!button) throw new Error('missing the pop-out button')
      return button
    })
    await act(async () => popOut.click())
    await act(async () => windowReads.at(-1)?.next(answer))
    const related = await vi.waitFor(() => {
      const row = document.querySelector<HTMLButtonElement>('[data-related-task] button')
      if (!row) throw new Error('missing the related row')
      return row
    })
    await act(async () => related.click())
    // both windows stay, on the related task, which loads from the server
    expect(store.P.handleOf('fd000000-b')).toBeNull()
    expect(document.querySelector('[data-task-scrim]')).not.toBeNull()
    expect(paneWindow()).not.toBeNull()
    expect(container.querySelector('.inbox-detail-frame [data-task-loading]')).not.toBeNull()
  })
})

describe('the Inbox at a task still to arrive', { timeout: 20_000 }, () => {
  it('shows the pane that says so on a phone, with Close', async () => {
    // only the phone breakpoint matches
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(max-width: 760px)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
    const { taskRef } = await import('../lib/taskReference')
    const { opened } = await loadingInbox((org) => taskRef({ org, num: 2 }))
    expect(container.querySelector('[data-inbox]')?.hasAttribute('data-inbox-mobile-detail')).toBe(
      true,
    )
    expect(container.querySelector('[data-task-loading]')?.textContent).toContain('Loading QN-2…')
    // the window's own Close
    const back = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Close')
    await act(async () => back?.click())
    expect(opened).toEqual([null])
    expect(container.querySelector('[data-inbox]')?.hasAttribute('data-inbox-mobile-detail')).toBe(
      false,
    )
  })

  it('closes the pane on Escape before it leaves the Inbox', async () => {
    const { taskRef } = await import('../lib/taskReference')
    const { opened, onExit } = await loadingInbox((org) => taskRef({ org, num: 2 }))
    expect(container.querySelector('[data-task-loading]')).not.toBeNull()
    const pressEscape = () =>
      act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      })
    await pressEscape()
    expect(opened).toEqual([null])
    expect(onExit).not.toHaveBeenCalled()
    expect(container.querySelector('[data-task-loading]')).toBeNull()
    await pressEscape()
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('closes the pop-out, then the pane, on Escape, also over a task still to arrive', async () => {
    const { snap, opened, goTo } = await loadingInbox()
    // the workspace holds no task while every task loads: the pane reads it
    const { taskRef } = await import('../lib/taskReference')
    await goTo(taskRef({ org: snap.orgs[0].id, uuid: '00000000-a' }))
    const row = snap.issues.find((it) => it.id === '00000000-a')
    await vi.waitFor(() => expect(windowReads.length).toBeGreaterThan(0))
    await act(async () =>
      windowReads.at(-1)?.next({ ...answerOf(snap), task: { ...row, has_subtasks: false } }),
    )
    const popOut = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[data-task-popout]')
      if (!button) throw new Error('missing the pop-out button')
      return button
    })
    await act(async () => popOut.click())
    expect(document.querySelector('[data-task-scrim]')).not.toBeNull()
    // Back to a task still to arrive, which both windows follow
    await goTo(taskRef({ org: snap.orgs[0].id, num: 2 }))
    expect(container.querySelector('[data-task-loading]')).not.toBeNull()
    expect(document.querySelector('[data-task-scrim]')).not.toBeNull()
    const pressEscape = () =>
      act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      })
    // the pop-out first, then the pane
    await pressEscape()
    expect(document.querySelector('[data-task-scrim]')).toBeNull()
    expect(container.querySelector('[data-task-loading]')).not.toBeNull()
    expect(opened).toEqual([])
    await pressEscape()
    expect(opened).toEqual([null])
    // the next item opens in the pane, not in a pop-out
    const open = container.querySelector<HTMLButtonElement>(
      '[data-message="00000000-a"] .inbox-message-open',
    )
    await act(async () => open?.click())
    expect(opened.at(-1)).toBeTruthy()
    await act(async () =>
      windowReads.at(-1)?.next({ ...answerOf(snap), task: { ...row, has_subtasks: false } }),
    )
    expect(container.querySelector('[data-task-popout]')).not.toBeNull()
    expect(document.querySelector('[data-task-scrim]')).toBeNull()
  })
})

describe('the Inbox of a session that never asked for every task', { timeout: 20_000 }, () => {
  beforeEach(async () => {
    const { TASKS } = await import('../store/liveParts')
    TASKS.atBoot = false
  })
  afterEach(async () => {
    const { TASKS } = await import('../store/liveParts')
    TASKS.atBoot = true
    // no write went out on a path that needs every task, and no paint threw
    const { __layerProbe } = await import('../store/planner')
    expect(__layerProbe?.faults()).toEqual([])
  })

  /** Types `text` into the Inbox's search, as a person does. */
  const search = (text: string) =>
    act(async () => {
      const input = container.querySelector<HTMLInputElement>('[data-inbox-search]')
      if (!input) throw new Error('missing the search')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  const rows = () =>
    [...container.querySelectorAll<HTMLElement>('[data-message]')].map((row) => row.dataset.message)

  it('opens a row’s task in the pane from its own read, asking nothing', async () => {
    const { store } = await loadingInbox()
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
    const open = container.querySelector<HTMLButtonElement>(
      '[data-message="00000000-a"] .inbox-message-open',
    )
    await act(async () => open?.click())
    await vi.waitFor(() => expect(windowReads.length).toBeGreaterThan(0))
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
  })

  it('searches on the server by task ID and asks for no task', async () => {
    const { store } = await loadingInbox()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    // QN-2 is the soak test's task ID, which the workspace does not hold
    await search('QN-2')
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)))
    await vi.waitFor(() => expect(rows()).toEqual(['fd000000-b']))
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
    expect(store.__layerProbe?.asks()).toEqual([])
  })
})
