// @vitest-environment jsdom
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { getFunctionName } from 'convex/server'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The task window on a task the workspace does not hold, on the real store:
   from the window's own read of the task (convex/taskWindow.ts task,
   P.taskDetail), answered by hand, read-only but for its comments, and an
   archived task's read-only window. Mira leads Work, where the family task
   "Calibrate the sensor" (QN-27) lives, and only views Manuals. The far
   tasks (QN-40 on) are on the server but not in the workspace: in a task
   window still to arrive while it loads in stages (`loading`), else not in
   it at all. */

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

type Planner = typeof import('../store/planner')['P']
type Task = Snapshot['issues'][number]
/* One subscription the store made, its answers and whether it stopped. */
type Live = {
  name: string
  args: Record<string, unknown>
  deliver: (value: unknown) => void
  fail: (e: unknown) => void
  closed: boolean
}

const AT = '2026-09-14T08:00:00.000Z'
const WAITS = 'Available once every task has loaded'
const READ_ONLY = 'Read-only project access'
/* The family task, in the first task window, which a staged load brings
   first. */
const FAM = '01000000-0000-4000-8000-000000000027'
/* Far tasks: ids in the last of 64 task windows, which starts at fc000000,
   so a staged load holds them back. */
const FAR = 'fd000000-0000-4000-8000-000000000040'
const FAR_RO = 'fd000000-0000-4000-8000-000000000041'
const FAR_KID = 'fd000000-0000-4000-8000-000000000042'
const FAR_KID_2 = 'fd000000-0000-4000-8000-000000000043'
// a day as YYYY-MM-DD, `days` from today
const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

let P: Planner
let container: HTMLDivElement
let root: Root
let snap: Snapshot
let subs: Live[]
let publish: (next: Snapshot) => void
let onOpen: Mock<(id: string) => void>
let onClose: Mock<() => void>

const task = (id: string, num: number, extra: Partial<Task> = {}): Task => ({
  id,
  org_id: snap.orgs[0].id,
  project_id: 'work',
  num,
  title: `Task ${num}`,
  description: '',
  status: 'todo',
  priority: 'medium',
  paused: false,
  created_at: AT,
  updated_at: AT,
  has_hidden_subtasks: false,
  has_hidden_parent: false,
  ...extra,
})
/* Task `row` as the short row an answer sends (convex/lib/taskWindow.ts). */
const short = (row: Task, has_subtasks = false) => {
  const {
    description: _text,
    parent_id: _parent,
    has_hidden_subtasks: _hidden,
    has_hidden_parent: _hiddenParent,
    ...rest
  } = row
  return { ...rest, has_subtasks, level: row.project_id === 'manuals' ? 'viewer' : 'lead' }
}
/* The far task QN-40, owned by Mira, with 400 hours left and due in two
   weeks, which only her other work can say is late. */
const far = (extra: Partial<Task> = {}) =>
  task(FAR, 40, {
    title: 'Tune the antenna',
    description: 'Measure the gain at **three** heights.',
    status: 'progress',
    assignee_id: 'mira',
    remaining_hours: 400,
    due_date: day(14),
    ...extra,
  })
/* The task answer of `row` (convex/lib/taskWindow.ts readWindowTask). */
const okAnswer = (row: Task, extra: Record<string, unknown> = {}) => ({
  state: 'ok',
  task: { ...row, has_subtasks: false },
  level: row.project_id === 'manuals' ? 'viewer' : 'lead',
  labels: [],
  follow: null,
  parent: null,
  subtasks: { rows: [], complete: true },
  ...extra,
})
/* The archived answer of `row`, with its text, at `level`. */
const archivedAnswer = (row: Task, level = 'lead', is_group = false) => {
  const {
    description,
    parent_id: _parent,
    has_hidden_subtasks: _hidden,
    has_hidden_parent: _hiddenParent,
    ...page
  } = row
  return {
    state: 'archived',
    task: { ...page, archived_at: '2026-09-14T09:00:00.000Z', is_group },
    description,
    labels: [{ issue_id: row.id, label_id: 'label-1' }],
    level,
  }
}
const comment = (id: string, issue: string, author: string, body: string) => ({
  id,
  issue_id: issue,
  author,
  body,
  created_at: AT,
})

/* Mira, Leo, Work under Plan (Mira leads it, with delay tracking) and
   Manuals under Docs (Mira views it), the family task, and with `loading`
   the far tasks in a task window still to arrive. */
function fixture(loading: boolean) {
  const next = plannerFixture()
  snap = next
  const me = next.profiles[0]
  Object.assign(me, { id: 'mira', name: 'Mira Holm', org_role: 'user' })
  next.myProfileIds = ['mira']
  next.profiles.push({ ...me, id: 'leo', name: 'Leo Park', auth_user_id: 'account-leo' })
  const base = next.projects[0]
  next.projects = [
    { ...base, id: 'plan', type: 'meta', key: 'PLAN', name: 'Plan', lead_id: 'mira' },
    {
      ...base,
      id: 'work',
      type: 'project',
      key: 'WORK',
      num: 2,
      name: 'Work',
      parent_id: 'plan',
      track_delay: true,
    },
    { ...base, id: 'bench', type: 'project', key: 'BEN', num: 5, name: 'Bench', parent_id: 'plan' },
    { ...base, id: 'docs', type: 'meta', key: 'DOC', num: 3, name: 'Docs', lead_id: 'leo' },
    {
      ...base,
      id: 'manuals',
      type: 'project',
      key: 'MAN',
      num: 4,
      name: 'Manuals',
      parent_id: 'docs',
    },
  ]
  next.access.push({ project_id: 'docs', profile_id: 'mira', level: 'viewer' })
  next.labels.push({
    id: 'label-1',
    org_id: next.orgs[0].id,
    name: 'Hardware',
    name_lower: 'hardware',
    color: '#335577',
    created_at: AT,
  })
  // 12,800 task numbers make 64 task windows
  next.orgs[0].next_issue_num = loading ? 64 * 200 : 60
  next.issues.push(task(FAM, 27, { title: 'Calibrate the sensor', status: 'progress' }))
  if (loading)
    next.issues.push(
      far(),
      task(FAR_RO, 41, { title: 'Read the far manual', project_id: 'manuals' }),
    )
  return next
}

/* Loads the store; with `loading`, the last task window stays back until
   arrive(). */
async function load(loading = false) {
  vi.resetModules()
  snap = fixture(loading)
  subs = []
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      publish = (value) => next(structuredClone(value))
      next(structuredClone(snap))
      return () => {}
    }
    const live: Live = { name, args, deliver: next, fail, closed: false }
    subs.push(live)
    return () => {
      live.closed = true
    }
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  const store = await import('../store/planner')
  P = store.P
  if (loading) double.live?.holdWindow('fc000000')
  await store.initStore()
  expect(P.stillLoading() !== null).toBe(loading)
}

/* The last task window arrives, and with it every task. */
const arrive = () =>
  act(async () => {
    double.live?.holdWindow(null)
    publish(snap)
  })

/* Notes task `row` as Search or a task window notes one it opens
   (lib/openedTasks.ts), and answers its handle. */
async function noteTask(row: Task) {
  const { noteOpenedTask } = await import('../lib/openedTasks')
  noteOpenedTask({
    uuid: row.id,
    num: row.num,
    key: `QN-${row.num}`,
    title: row.title,
    project: row.project_id,
    org: row.org_id,
  })
  return P.handleNow(row.id, row.org_id, row.num)
}

/* Opens the window on handle `first`, which follows the tasks it opens,
   on a desktop, or on a phone with `phone`. */
async function openWindow(first: string) {
  const { IssueDetail } = await import('./IssueDetail')
  const { usePlannerVersion } = await import('../store/usePlannerVersion')
  function Host() {
    usePlannerVersion()
    const [issueId, setIssueId] = useState<string | null>(first)
    return (
      <IssueDetail
        issueId={issueId}
        onClose={onClose}
        onOpen={(id) => {
          onOpen(id)
          setIssueId(id)
        }}
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
}

/* Stubs the phone breakpoint, or the desktop one. */
const viewport = (phone: boolean) =>
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: phone, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  viewport(false)
  window.showToast = vi.fn()
  onOpen = vi.fn<(id: string) => void>()
  onClose = vi.fn<() => void>()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  double.live?.holdWindow(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const open = (name: string) => subs.filter((s) => s.name === name && !s.closed)
const reads = () => subs.filter((s) => s.name === 'taskWindow:task')
function one(name: string): Live {
  const live = open(name)
  expect(live).toHaveLength(1)
  return live[0]
}
const answer = (name: string, value: unknown) => act(async () => one(name).deliver(value))
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"], [role="region"]')
const note = () => document.querySelector<HTMLElement>('[data-task-gone] [role="status"]')
const field = (label: string) =>
  document.querySelector<HTMLButtonElement>(`[data-fieldselect][aria-label="${label}"]`)
const buttonNamed = (name: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === name)
async function click(element: Element | null | undefined) {
  if (!(element instanceof HTMLElement)) throw new Error('nothing to click')
  await act(async () => element.click())
}
/* The tooltip of `element`, which a control draws from its title, as a
   pointer over it opens it; a disabled control takes no focus. */
async function hintOf(element: Element | null | undefined) {
  const trigger = element?.closest<HTMLElement>('[data-tooltip-trigger]')
  if (!trigger) return element instanceof HTMLElement ? element.title || null : null
  const pointer = (type: string) =>
    Object.assign(new MouseEvent(type, { bubbles: true }), { pointerType: 'mouse' })
  await act(async () => {
    trigger.dispatchEvent(pointer('pointermove'))
    await new Promise((resolve) => setTimeout(resolve, 400))
  })
  const tip = document.querySelector('[data-slot="tooltip-content"]')
  const text = tip?.firstChild?.textContent ?? null
  await act(async () => trigger.dispatchEvent(pointer('pointerleave')))
  return text
}
/* The items of the Task actions menu, by their text, once it opens. The
   window takes focus a frame after it opens, which would close a menu
   opened before; an archived task's note takes it instead. */
async function taskActions() {
  await act(async () => {
    await vi.waitFor(() => {
      if (!dialog()?.contains(document.activeElement))
        throw new Error('the window has no focus yet')
    })
  })
  await click(document.querySelector('[aria-label="Task actions"]'))
  return (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes(text),
    )
}
function editorOf(label: string) {
  return vi.waitFor(
    () => {
      const found = document.querySelector<TiptapEditorHTMLElement>(
        `[role="textbox"][aria-label="${label}"]`,
      )?.editor
      if (!found) throw new Error(`missing the ${label} editor`)
      return found
    },
    { timeout: 10_000 },
  )
}
const delayChip = () => document.querySelector<HTMLElement>('[data-delay-chip]')
const dueText = () =>
  [...document.querySelectorAll('.task-field')]
    .find((f) => f.querySelector('.task-field-label')?.textContent === 'Due')
    ?.querySelector('.task-field-value')?.textContent

describe('the task window on a task the workspace does not hold', { timeout: 30_000 }, () => {
  it('shows each state of its read apart', async () => {
    await load()
    const handle = await noteTask(far())
    await openWindow(handle)
    // noted and never shown, before the read answers
    expect(note()?.textContent).toBe('Loading QN-40…')
    expect(document.querySelector('[data-task-gone-task]')?.textContent).toContain(
      'Tune the antenna',
    )
    expect(one('taskWindow:task').args).toEqual({ org_id: snap.orgs[0].id, ref: FAR })
    // a failed read, with Retry, which reads it again
    await act(async () => one('taskWindow:task').fail(new Error('Server Error')))
    expect(note()?.textContent).toBe("Couldn't open QN-40. Couldn't check the archive.")
    await click(buttonNamed('Retry'))
    expect(note()?.textContent).toBe('Loading QN-40…')
    expect(reads()).toHaveLength(2)
    await answer('taskWindow:task', okAnswer(far()))
    expect(document.querySelector('[data-task-gone]')).toBeNull()
    expect(dialog()?.dataset.taskSource).toBe('answer')
    expect(document.querySelector('[data-task-title]')?.textContent).toBe('Tune the antenna')
    expect(dialog()?.textContent).toContain('three')
    // archived meanwhile: the note above the task, read-only
    await answer('taskWindow:task', archivedAnswer(far()))
    expect(dialog()?.dataset.taskArchived).toBe('')
    expect(note()?.textContent).toBe(
      'QN-40 was archived. Restore it to bring it back to the board.',
    )
    // gone: what the server says of every task it will not show
    await answer('taskWindow:task', { state: 'unavailable' })
    expect(note()?.textContent).toBe(
      'QN-40 is no longer here. It was deleted, or you can no longer open it.',
    )
    expect(dialog()?.dataset.taskSource).toBeUndefined()
    expect(dialog()?.textContent).not.toContain('three')
  })

  it('waits for a handle it knows nothing of, while tasks load, and opens nothing once loaded', async () => {
    await load(true)
    await openWindow('QN-99')
    expect(document.querySelector('[data-task-loading]')?.textContent).toContain(
      'Loading this task…',
    )
    expect(reads()).toEqual([])
    await act(async () => root.unmount())
    root = createRoot(container)
    await load()
    await openWindow('QN-99')
    expect(dialog()?.getAttribute('aria-hidden')).toBe('true')
    expect(document.querySelector('[data-task-loading], [data-task-gone]')).toBeNull()
  })

  it('says a task it showed is no longer on the board until its read answers, and loading while tasks load', async () => {
    await load()
    await openWindow('QN-27')
    expect(dialog()?.dataset.taskSource).toBe('workspace')
    // its details column asked for its read, which has not answered yet
    expect(one('taskWindow:task').args).toEqual({ org_id: snap.orgs[0].id, ref: FAM })
    const left = structuredClone(snap)
    left.issues = left.issues.filter((t) => t.id !== FAM)
    await act(async () => publish(left))
    expect(note()?.textContent).toBe('QN-27 is no longer on the board.')
    // the same read goes on, now for the window's view of the task
    expect(reads()).toHaveLength(1)
    await answer('taskWindow:task', archivedAnswer(snap.issues[0]))
    expect(dialog()?.dataset.taskArchived).toBe('')
    // while tasks still load, a task the window showed before waits for its
    // read as for the tasks still to come, once no answer shows it
    await act(async () => root.unmount())
    root = createRoot(container)
    await load(true)
    const handle = await noteTask(far())
    await openWindow(handle)
    await answer('taskWindow:task', okAnswer(far()))
    await answer('taskWindow:task', { state: 'unavailable' })
    await act(async () => one('taskWindow:task').fail(new Error('Server Error')))
    expect(note()?.textContent).toBe("QN-40 is no longer on the board. Couldn't check the archive.")
    await click(buttonNamed('Retry'))
    expect(document.querySelector('[data-task-loading]')?.textContent).toContain(
      'Loading this task…',
    )
    await answer('taskWindow:task', okAnswer(far()))
    expect(dialog()?.dataset.taskSource).toBe('answer')
  })

  it('keeps a task and the comment typed for it through a failed read and its Retry, until the server says it is gone', async () => {
    await load()
    const handle = await noteTask(far())
    await openWindow(handle)
    await answer('taskWindow:task', okAnswer(far()))
    await answer('snapshot:threadComments', { comments: [], earlier: false })
    const composer = await editorOf('Leave a comment')
    await act(async () => composer.commands.insertContent('Gain looks low'))
    const stale = () => document.querySelector<HTMLElement>('[data-task-stale]')
    // the read fails: the task stays as it last loaded, with the draft
    await act(async () => one('taskWindow:task').fail(new Error('Server Error')))
    expect(stale()?.dataset.taskStale).toBe('failed')
    expect(stale()?.textContent).toContain(
      "Couldn't check QN-40 for changes, so it shows as it was last loaded.",
    )
    expect(dialog()?.dataset.taskSource).toBe('answer')
    expect(document.querySelector('[data-task-gone]')).toBeNull()
    expect(document.querySelector('[data-task-title]')?.textContent).toBe('Tune the antenna')
    expect((await editorOf('Leave a comment')).getText()).toBe('Gain looks low')
    expect(composer.isDestroyed).toBe(false)
    // Retry reads it again, and the draft stays meanwhile; focus moves
    // from Retry, which leaves, to the note
    const retry = buttonNamed('Retry', stale() ?? document)
    act(() => retry?.focus())
    await click(retry)
    expect(document.activeElement).toBe(stale()?.querySelector('[role="status"]'))
    expect(stale()?.dataset.taskStale).toBe('retrying')
    expect(stale()?.textContent).toBe('Checking QN-40 for changes…')
    expect(reads()).toHaveLength(2)
    expect(composer.getText()).toBe('Gain looks low')
    await answer('taskWindow:task', okAnswer(far({ title: 'Tune the antenna again' })))
    expect(stale()).toBeNull()
    expect(document.querySelector('[data-task-title]')?.textContent).toBe('Tune the antenna again')
    expect(composer.isDestroyed).toBe(false)
    expect(composer.getText()).toBe('Gain looks low')
    expect(window.showToast).not.toHaveBeenCalledWith('Unsaved comment discarded', 'error')
    // gone for good: its note replaces the task, and the draft with it
    await answer('taskWindow:task', { state: 'unavailable' })
    expect(note()?.textContent).toBe(
      'QN-40 is no longer here. It was deleted, or you can no longer open it.',
    )
    expect(dialog()?.dataset.taskSource).toBeUndefined()
    expect(document.querySelector('[role="textbox"][aria-label="Leave a comment"]')).toBeNull()
    expect(stale()).toBeNull()
  })

  it('shows a task from its answer read-only, saying why each control is off, with comments for an editor', async () => {
    await load()
    const handle = await noteTask(far())
    await openWindow(handle)
    await answer(
      'taskWindow:task',
      okAnswer(far(), {
        task: { ...far(), has_subtasks: false, has_hidden_parent: true },
        follow: { issue_id: FAR, profile_id: 'mira', created_at: AT },
      }),
    )
    await answer('snapshot:threadComments', {
      comments: [
        comment('c-1', FAR, 'mira', 'Measured at one metre'),
        comment('c-2', FAR, 'leo', 'Try two'),
      ],
      earlier: false,
    })
    for (const label of ['Status', 'Priority', 'Assignee', 'Reviewer']) {
      expect(field(label)?.disabled, label).toBe(true)
      expect(await hintOf(field(label)), label).toBe(WAITS)
    }
    const remaining = document.querySelector<HTMLInputElement>('[data-remaining-input]')
    expect(remaining?.disabled).toBe(true)
    expect(await hintOf(remaining)).toBe(WAITS)
    const roadmap = document.querySelector<HTMLButtonElement>('[data-plan-on-roadmap]')
    expect(roadmap?.disabled).toBe(true)
    expect(await hintOf(roadmap)).toBe(WAITS)
    // the title stays as it is, and the description reads, without a field
    await click(document.querySelector('[data-task-title]'))
    expect(document.querySelector('[aria-label="Task title"]')).toBeNull()
    expect(document.querySelector('[data-task-description] .descfield')).toBeNull()
    expect(document.querySelector('[data-task-description]')?.textContent).toContain('three')
    // the follow eye says Mira follows it, and waits
    const eye = document.querySelector<HTMLButtonElement>('[data-task-subscribe]')
    expect(eye?.dataset.taskSubscribe).toBe('on')
    expect(eye?.disabled).toBe(true)
    // no label is added or removed
    expect(document.querySelector('[aria-label="Add label"]')).toBeNull()
    // Parent from the answer, exactly
    expect(document.body.textContent).toContain('The parent task is outside this view.')
    expect(document.body.textContent).not.toContain('still loading')
    // the composer, and the edits of a comment's author and of a lead
    expect(document.querySelector('[data-composer]')).not.toBeNull()
    const commentRow = (id: string) => document.querySelector(`[data-comment="${id}"]`)
    expect(commentRow('c-1')?.querySelector('[aria-label="Edit comment"]')).not.toBeNull()
    expect(
      commentRow('c-2')?.querySelector('[aria-label="Edit comment (project lead)"]'),
    ).not.toBeNull()
    // Move and Archive or delete show, waiting for every task
    const item = await taskActions()
    for (const text of ['Move to sub-project…', 'Archive or delete…']) {
      const control = item(text)
      expect(control instanceof HTMLButtonElement && control.disabled, text).toBe(true)
      expect(await hintOf(control), text).toBe(WAITS)
    }
    expect(item('Copy link')).toBeDefined()
  })

  it('shows a task in a project the person views without a composer, saying it is read-only', async () => {
    await load()
    const row = task(FAR_RO, 41, { title: 'Read the far manual', project_id: 'manuals' })
    const handle = await noteTask(row)
    await openWindow(handle)
    await answer('taskWindow:task', okAnswer(row))
    await answer('snapshot:threadComments', {
      comments: [comment('c-1', FAR_RO, 'mira', 'Mine'), comment('c-2', FAR_RO, 'leo', 'Theirs')],
      earlier: false,
    })
    expect(await hintOf(field('Priority'))).toBe(READ_ONLY)
    // the Roadmap opens a task of a project the person views, once it loads
    const roadmap = document.querySelector<HTMLButtonElement>('[data-plan-on-roadmap]')
    expect(roadmap?.disabled).toBe(true)
    expect(await hintOf(roadmap)).toBe(WAITS)
    expect(document.querySelector('[data-composer]')).toBeNull()
    // an author edits their own comment; a viewer no one else's
    expect(
      document.querySelector('[data-comment="c-1"] [aria-label="Edit comment"]'),
    ).not.toBeNull()
    expect(document.querySelector('[data-comment="c-2"] [aria-label^="Edit comment"]')).toBeNull()
    const item = await taskActions()
    expect(item('Archive or delete…')).toBeUndefined()
  })

  it("shows a group's Progress, Remaining and Plan from a complete list, and unknown from an incomplete one", async () => {
    await load()
    const handle = await noteTask(far())
    await openWindow(handle)
    const kid = (id: string, num: number, extra: Partial<Task>) =>
      short(task(id, num, { parent_id: FAR, ...extra }))
    const kids = [
      kid(FAR_KID, 42, {
        status: 'done',
        remaining_hours: 2,
        start_week: '2026-03-02',
        end_week: '2026-03-09',
      }),
      kid(FAR_KID_2, 43, { remaining_hours: 3, start_week: '2026-03-16', end_week: '2026-03-16' }),
    ]
    const group = { ...far(), has_subtasks: true }
    await answer(
      'taskWindow:task',
      okAnswer(far(), { task: group, subtasks: { rows: kids, complete: true } }),
    )
    const progress = () => document.querySelector('[data-progress]')?.textContent
    expect(progress()).toContain('1 of 2 tasks done, 50%')
    expect(document.querySelector('[data-remaining-rollup]')?.textContent).toBe('Σ 3h')
    expect(document.querySelector('[data-plan-unknown]')).toBeNull()
    // the subtasks are rows of the section, from the same read
    expect(
      [...document.querySelectorAll('[data-section="subtasks"] [data-related-task]')].map((r) =>
        r.getAttribute('data-related-task'),
      ),
    ).toEqual(['QN-42', 'QN-43'])
    expect(reads()).toHaveLength(1)
    await answer(
      'taskWindow:task',
      okAnswer(far(), {
        task: { ...group, has_hidden_subtasks: true },
        subtasks: { rows: kids.slice(0, 1), complete: false },
      }),
    )
    expect(progress()).toContain('Completion unknown.')
    expect(document.querySelector('[data-remaining-rollup]')?.textContent).toBe('Unknown')
    expect(document.querySelector('[data-plan-unknown]')?.textContent).toBe('Unknown')
  })

  it('turns editable in place when the task arrives, keeping a comment typed meanwhile', async () => {
    await load(true)
    const handle = await noteTask(far())
    await openWindow(handle)
    await answer('taskWindow:task', okAnswer(far()))
    await answer('snapshot:threadComments', { comments: [], earlier: false })
    expect(field('Priority')?.disabled).toBe(true)
    const composer = await editorOf('Leave a comment')
    await act(async () => composer.commands.insertContent('Gain looks low'))
    await arrive()
    expect(dialog()?.dataset.taskSource).toBe('workspace')
    expect(field('Priority')?.disabled).toBe(false)
    expect((await editorOf('Leave a comment')).getText()).toBe('Gain looks low')
    expect(composer.isDestroyed).toBe(false)
    // the read stops with no section to read it for; the details column's
    // sections ask afresh
    expect(open('taskWindow:task')).toHaveLength(1)
  })

  it('opens a related task the workspace does not hold from its own read, and names its organization in the address', async () => {
    await load()
    await openWindow('QN-27')
    const kidRow = task(FAR_KID, 42, { title: 'Wind the coil', parent_id: FAM })
    await answer(
      'taskWindow:task',
      okAnswer(snap.issues[0], {
        task: { ...snap.issues[0], has_subtasks: true },
        subtasks: { rows: [short(kidRow)], complete: true },
      }),
    )
    const row = document.querySelector('[data-section="subtasks"] [data-related-task="QN-42"]')
    await click(row?.querySelector('button'))
    expect(onOpen).toHaveBeenCalledWith('QN-42')
    // the window reads it, in its organization
    expect(one('taskWindow:task').args).toEqual({ org_id: snap.orgs[0].id, ref: FAR_KID })
    const { buildPath, issueLink } = await import('../lib/router')
    expect(buildPath({ view: 'kanban', openIssue: 'QN-42' })).toBe('/app/testbed/board/tasks/qn-42')
    expect(issueLink('QN-42')).toBe('/app/testbed/tasks/qn-42')
    await answer('taskWindow:task', okAnswer(kidRow, { parent: short(snap.issues[0], true) }))
    expect(document.querySelector('[data-task-title]')?.textContent).toBe('Wind the coil')
    // its Parent row is the held family task
    expect(document.querySelector('[data-related-task="QN-27"]')?.textContent).toContain(
      'Calibrate the sensor',
    )
  })

  it('keeps the read and the view when a phone switches from Details back to Activity', async () => {
    viewport(true)
    await load()
    const handle = await noteTask(far())
    await openWindow(handle)
    await answer('taskWindow:task', okAnswer(far()))
    const read = one('taskWindow:task')
    await click(buttonNamed('Details'))
    expect(one('taskWindow:links')).toBeDefined()
    expect(one('taskWindow:task')).toBe(read)
    await click(buttonNamed('Activity'))
    expect(open('taskWindow:links')).toEqual([])
    expect(one('taskWindow:task')).toBe(read)
    expect(dialog()?.dataset.taskSource).toBe('answer')
    expect(document.querySelector('[data-task-title]')?.textContent).toBe('Tune the antenna')
  })
})

describe('the task window as the workspace and the answer disagree', { timeout: 30_000 }, () => {
  /* The family task as the workspace holds it. */
  const fam = () => {
    const row = snap.issues.find((t) => t.id === FAM)
    if (!row) throw new Error('missing the family task')
    return row
  }
  /* A delivery of the workspace without the family task. */
  const withoutFam = () => {
    const left = structuredClone(snap)
    left.issues = left.issues.filter((t) => t.id !== FAM)
    return left
  }
  const leadEdit = () =>
    document.querySelector('[data-comment="c-2"] [aria-label="Edit comment (project lead)"]')

  it('offers the composer, lead edits and Restore only when both the answer and the workspace allow them', async () => {
    await load()
    // the answer says Mira leads Manuals, which the workspace says she views
    const row = task(FAR_RO, 41, { title: 'Read the far manual', project_id: 'manuals' })
    await openWindow(await noteTask(row))
    await answer('taskWindow:task', okAnswer(row, { level: 'lead' }))
    await answer('snapshot:threadComments', {
      comments: [comment('c-2', FAR_RO, 'leo', 'Theirs')],
      earlier: false,
    })
    expect(dialog()?.dataset.taskSource).toBe('answer')
    expect(document.querySelector('[data-composer]')).toBeNull()
    expect(leadEdit()).toBeNull()
    await answer('taskWindow:task', archivedAnswer(row, 'lead'))
    expect(note()?.textContent).toContain('was archived')
    expect(buttonNamed('Restore')).toBeUndefined()
    // and the other way: the answer says she views Work, which she leads
    await act(async () => root.unmount())
    root = createRoot(container)
    await load()
    await openWindow(await noteTask(far()))
    await answer('taskWindow:task', okAnswer(far(), { level: 'viewer' }))
    await answer('snapshot:threadComments', {
      comments: [comment('c-2', FAR, 'leo', 'Theirs')],
      earlier: false,
    })
    expect(dialog()?.dataset.taskSource).toBe('answer')
    expect(document.querySelector('[data-composer]')).toBeNull()
    expect(leadEdit()).toBeNull()
    await answer('taskWindow:task', archivedAnswer(far(), 'viewer'))
    expect(buttonNamed('Restore')).toBeUndefined()
    // both agree: all three
    await answer('taskWindow:task', okAnswer(far()))
    expect(document.querySelector('[data-composer]')).not.toBeNull()
    expect(leadEdit()).not.toBeNull()
    await answer('taskWindow:task', archivedAnswer(far()))
    expect(buttonNamed('Restore')).toBeDefined()
  })

  it('discards a comment typed for a task its answer then says is archived, and says so', async () => {
    await load()
    await openWindow(await noteTask(far()))
    await answer('taskWindow:task', okAnswer(far()))
    await answer('snapshot:threadComments', { comments: [], earlier: false })
    const composer = await editorOf('Leave a comment')
    await act(async () => composer.commands.insertContent('Gain looks low'))
    await answer('taskWindow:task', archivedAnswer(far()))
    expect(dialog()?.dataset.taskArchived).toBe('')
    expect(document.querySelector('[role="textbox"][aria-label="Leave a comment"]')).toBeNull()
    expect(window.showToast).toHaveBeenCalledWith('Unsaved comment discarded', 'error')
  })

  it('discards a title typed for a task that leaves the workspace and stays shown from its answer', async () => {
    await load()
    await openWindow('QN-27')
    await answer('taskWindow:task', okAnswer(fam()))
    await click(document.querySelector('[data-task-title]'))
    const title = document.querySelector<HTMLTextAreaElement>('[aria-label="Task title"]')
    if (!title) throw new Error('the title field did not open')
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(title), 'value')?.set?.call(
        title,
        'Calibrate the sensor twice',
      )
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => publish(withoutFam()))
    expect(dialog()?.dataset.taskSource).toBe('answer')
    expect(document.querySelector('[aria-label="Task title"]')).toBeNull()
    expect(document.querySelector('[data-task-title]')?.textContent).toBe('Calibrate the sensor')
    expect(window.showToast).toHaveBeenCalledWith('Unsaved title discarded')
    expect(
      network.mutation.mock.calls.filter(([ref]) => getFunctionName(ref).startsWith('issues:')),
    ).toEqual([])
  })

  it('closes a picker of a task that leaves the workspace, so it does not open again when the task comes back', async () => {
    await load()
    await openWindow('QN-27')
    await answer('taskWindow:task', okAnswer(fam()))
    const picker = () => document.querySelector('input[placeholder="Add labels…"]')
    // the window takes focus a frame after it opens, which would close a
    // picker opened before; the picker opens a frame after the press
    await act(async () => {
      await vi.waitFor(() => {
        if (!dialog()?.contains(document.activeElement))
          throw new Error('the window has no focus yet')
      })
    })
    await click(document.querySelector('button[aria-label="Add label"]'))
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    expect(picker()).not.toBeNull()
    await act(async () => publish(withoutFam()))
    expect(dialog()?.dataset.taskSource).toBe('answer')
    expect(picker()).toBeNull()
    await act(async () => publish(snap))
    expect(dialog()?.dataset.taskSource).toBe('workspace')
    expect(picker()).toBeNull()
  })
})

describe('the delay of a task the window cannot judge', { timeout: 30_000 }, () => {
  it('says the delay is unknown while tasks load, and the verdict once they have', async () => {
    await load(true)
    const handle = await noteTask(far())
    await openWindow(handle)
    await answer('taskWindow:task', okAnswer(far()))
    expect(delayChip()?.dataset.delayChip).toBe('unknown')
    expect(delayChip()?.textContent).toBe('Delay unknown')
    expect(await hintOf(delayChip())).toBe(
      "The projection needs the owner's other work, which has not loaded yet.",
    )
    await arrive()
    // 400 hours do not fit in two weeks of Mira's time
    expect(delayChip()?.dataset.delayChip).toBe('late')
    expect(delayChip()?.textContent).toBe('Delayed')
  })

  it('says Overdue for a passed due date, and nothing for a Done task or one without a due date or plan', async () => {
    await load()
    const handle = await noteTask(far())
    await openWindow(handle)
    await answer('taskWindow:task', okAnswer(far({ due_date: day(-2) })))
    expect(delayChip()).toBeNull()
    expect(dueText()).toContain('Overdue')
    await answer('taskWindow:task', okAnswer(far({ status: 'done' })))
    expect(delayChip()).toBeNull()
    expect(dueText()).not.toContain('Overdue')
    await answer('taskWindow:task', okAnswer(far({ due_date: undefined })))
    expect(delayChip()).toBeNull()
    // without an owner, the plan alone judges it, exactly
    await answer(
      'taskWindow:task',
      okAnswer(
        far({
          assignee_id: undefined,
          start_week: day(-28),
          end_week: day(-21),
          due_date: day(28),
        }),
      ),
    )
    expect(delayChip()?.dataset.delayChip).toBe('behind')
  })
})

describe('the archived task window', { timeout: 30_000 }, () => {
  /* Opens the archived far task as Search does, answered at `level`. */
  async function openArchived(level = 'lead', is_group = false) {
    await load()
    const handle = await noteTask(far())
    await openWindow(handle)
    await answer('taskWindow:task', archivedAnswer(far(), level, is_group))
    await answer('snapshot:threadComments', {
      comments: [comment('c-1', FAR, 'mira', 'Mounted the antenna')],
      earlier: false,
    })
  }

  it('shows the task read-only under its note, with its history under All, and restores it', async () => {
    await openArchived()
    expect(dialog()?.dataset.taskArchived).toBe('')
    expect(document.querySelector('[data-task-title]')?.textContent).toBe('Tune the antenna')
    expect(note()?.textContent).toBe(
      'QN-40 was archived. Restore it to bring it back to the board.',
    )
    expect(document.querySelector('[data-task-description]')?.textContent).toContain('three')
    expect(document.querySelector('.task-labels')?.textContent).toContain('Hardware')
    expect(field('Priority')?.disabled).toBe(true)
    expect(await hintOf(field('Priority'))).toBe('Restore this task to change it')
    expect(document.querySelector('[data-task-gone-archived]')?.textContent).toMatch(/^Archived/)
    // no files, parent, subtasks, links, follow eye or delay
    for (const name of ['attachments', 'subtasks', 'links'])
      expect(document.querySelector(`[data-section="${name}"]`)).toBeNull()
    expect(document.querySelector('[data-task-subscribe]')).toBeNull()
    expect(delayChip()).toBeNull()
    // its comments read-only
    expect(document.querySelector('[data-comment="c-1"]')?.textContent).toContain(
      'Mounted the antenna',
    )
    expect(document.querySelector('[data-comment="c-1"] [aria-label^="Edit comment"]')).toBeNull()
    expect(document.querySelector('[data-composer]')).toBeNull()
    // the menu copies, and moves or archives nothing
    const item = await taskActions()
    expect(item('Copy link')).toBeDefined()
    expect(item('Move to sub-project…')).toBeUndefined()
    expect(item('Archive or delete…')).toBeUndefined()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    // All reads its history
    await click(buttonNamed('All'))
    expect(one('snapshot:threadHistory').args).toEqual({ org_id: snap.orgs[0].id, issue_id: FAR })
    await answer('snapshot:threadHistory', {
      events: [
        {
          id: 'ev-1',
          org_id: snap.orgs[0].id,
          ts: AT,
          actor_id: 'leo',
          verb: 'archived',
          target_type: 'issue',
          target_id: FAR,
          label: 'QN-40',
        },
      ],
      earlier: false,
      next: null,
    })
    expect(document.querySelector('[data-event="ev-1"]')?.textContent).toContain('archived')
    // Restore, through the task's own organization; the restored task
    // comes back editable
    await click(buttonNamed('Restore'))
    const restores = network.mutation.mock.calls.filter(
      ([ref]) => getFunctionName(ref) === 'issues:unarchive',
    )
    expect(restores.map(([, args]) => args)).toEqual([{ org_id: snap.orgs[0].id, id: FAR }])
    snap.issues.push(far())
    await act(async () => publish(snap))
    expect(dialog()?.dataset.taskSource).toBe('workspace')
    expect(document.querySelector('[data-task-gone]')).toBeNull()
    expect(field('Priority')?.disabled).toBe(false)
  })

  it('keeps the archived window, its note and Restore through a failed read', async () => {
    await openArchived()
    await act(async () => one('taskWindow:task').fail(new Error('Server Error')))
    expect(dialog()?.dataset.taskArchived).toBe('')
    expect(document.querySelector('[data-task-stale]')?.textContent).toContain(
      "Couldn't check QN-40 for changes",
    )
    expect(note()?.textContent).toBe(
      'QN-40 was archived. Restore it to bring it back to the board.',
    )
    expect(buttonNamed('Restore')).toBeDefined()
    expect(document.querySelector('[data-comment="c-1"]')).not.toBeNull()
    await click(buttonNamed('Retry', document.querySelector('[data-task-stale]') ?? document))
    await answer('taskWindow:task', archivedAnswer(far()))
    expect(document.querySelector('[data-task-stale]')).toBeNull()
    expect(dialog()?.dataset.taskArchived).toBe('')
  })

  it('offers no Restore to someone who views its project, and says who can', async () => {
    await openArchived('viewer')
    expect(note()?.textContent).toBe(
      'QN-40 was archived. Someone who can edit its project can restore it from Archived tasks.',
    )
    expect(buttonNamed('Restore')).toBeUndefined()
    expect(await hintOf(field('Priority'))).toBe(READ_ONLY)
  })

  it("says an archived group's Progress, Remaining and Plan are unknown", async () => {
    await openArchived('lead', true)
    expect(document.querySelector('[data-progress]')?.textContent).toContain('Completion unknown.')
    expect(document.querySelector('[data-remaining-rollup]')?.textContent).toBe('Unknown')
    expect(document.querySelector('[data-plan-unknown]')?.textContent).toBe('Unknown')
    // a group has no status of its own
    expect(field('Status')).toBeNull()
  })

  it('shows only the note for the archived answer of an older backend, which holds no text', async () => {
    await load()
    const handle = await noteTask(far())
    await openWindow(handle)
    const { task: page } = archivedAnswer(far())
    await answer('taskWindow:task', { state: 'archived', task: page })
    expect(note()?.textContent).toBe(
      'QN-40 was archived. Restore it to bring it back to the board.',
    )
    expect(dialog()?.dataset.taskArchived).toBeUndefined()
    expect(document.querySelector('[data-task-gone-place]')?.textContent).toBe('Plan, Work')
    expect(dialog()?.textContent).not.toContain('No description.')
  })
})
