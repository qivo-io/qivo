// @vitest-environment jsdom
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { getFunctionName } from 'convex/server'
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { descriptionForm, printOf, trimmedForm } from '../../convex/lib/fieldPrints'
import { TooltipProvider } from '../components/ui/tooltip'
import { labelPickerStandIn } from '../store/labelPagesStandIn.setup'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The task window on a task the workspace does not hold, on the real store:
   from the window's own read of the task (convex/taskWindow.ts task,
   P.taskDetail), answered by hand, editable from that answer, each write
   sending the values the window showed, an image pasted into its
   description saved once it has uploaded, and an archived task's
   read-only window. Mira leads Work, where the family task
   "Calibrate the sensor" (QN-27) lives, and only views Manuals. The far
   tasks (QN-40 on) are on the server but not in the workspace: in a task
   window still to arrive while every task loads (`loading`), else not in
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
const WAITS_FOR_CHECK = 'Available once Qivo can check this task for changes'
const FAMILY_UNKNOWN = 'Not available while Qivo cannot read every subtask of this task'
const READ_ONLY = 'Read-only project access'
const STALE_SAVE =
  "Couldn't save yet. Saving is available once Qivo can check this task for changes."

/* The family task, in the first task window. */
const FAM = '01000000-0000-4000-8000-000000000027'
/* Far tasks: ids in the last of 64 task windows, which starts at fc000000,
   which a test holds back so every task is still on its way. */
const FAR = 'fd000000-0000-4000-8000-000000000040'
const FAR_RO = 'fd000000-0000-4000-8000-000000000041'
const FAR_KID = 'fd000000-0000-4000-8000-000000000042'
const FAR_KID_2 = 'fd000000-0000-4000-8000-000000000043'
/* Tasks a relation picker offers, which the workspace does not hold. */
const PICKED = 'fd000000-0000-4000-8000-000000000044'
const PICKED_2 = 'fd000000-0000-4000-8000-000000000045'
const PICKED_3 = 'fd000000-0000-4000-8000-000000000046'
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
// the handle the window is on now, which follows handle moves as App's does
let shownHandle: string | null

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

/* Loads the store, its fixture changed by `edit`; with `loading`, the last
   task window stays back until arrive(). */
async function load(loading = false, edit?: (next: Snapshot) => void) {
  vi.resetModules()
  network.mutation.mockClear()
  snap = fixture(loading)
  edit?.(snap)
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

/* The reference Search or a related row opens task `row` by when the
   workspace does not hold it (lib/taskReference.ts), with its
   organization, number and uuid. */
async function noteTask(row: Task) {
  const { taskRef } = await import('../lib/taskReference')
  return taskRef({ org: row.org_id, num: row.num, uuid: row.id })
}

/* Opens the window on handle `first`, which follows the tasks it opens
   and, as App does, the moves of their handles (P.watchHandles). */
async function openWindow(first: string) {
  const { IssueDetail } = await import('./IssueDetail')
  const { usePlannerVersion } = await import('../store/usePlannerVersion')
  function Host() {
    usePlannerVersion()
    const [issueId, setIssueId] = useState<string | null>(first)
    useEffect(
      () => P.watchHandles((moved) => setIssueId((cur) => (cur && moved.get(cur)) || cur)),
      [],
    )
    useEffect(() => {
      shownHandle = issueId
    }, [issueId])
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
/* The field labelled `label`. Assignee and Reviewer name their holder
   too, so they are found by their field, among the field selects, as an
   owner portrait carries data-owner-field too. */
const field = (label: string) =>
  document.querySelector<HTMLButtonElement>(
    `[data-fieldselect][aria-label="${label}"], [data-fieldselect][data-owner-field="${label.toLowerCase()}"]`,
  )
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
/* The writes of mutation `name` the store sent, their arguments in order. */
const sentArgs = (name: string) =>
  network.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === name)
    .map(([, args]) => args as Record<string, unknown>)
/* Types `value` into a field as a person does, which React hears. */
const typeInto = (field: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
/* Lets the next animation frame run, where a picker measures its place. */
const nextFrame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
/* The window's relation controls. */
const relationButtons = () =>
  ['Set parent', 'Add subtask', 'Link task'].map((label) =>
    document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`),
  )
/* The relation pickers' reads, held until the test answers each. */
function holdRelations() {
  const held: { args: Record<string, unknown>; answer: (value: unknown) => Promise<void> }[] = []
  network.query.mockImplementation((ref, args) =>
    getFunctionName(ref) === 'taskWindow:relationCandidates'
      ? new Promise((resolve) =>
          held.push({ args, answer: (value) => act(async () => resolve(value)) }),
        )
      : Promise.resolve(null),
  )
  return held
}
/* Task `row` as a relation picker's row, and an ended batch of `rows`. */
const pickerRow = (row: Task) => {
  const { has_subtasks: _group, ...rest } = short(row)
  return rest
}
const pickerBatch = (rows: unknown[]) => ({
  state: 'ok',
  rows,
  next: null,
  all_projects: null,
  stopped: false,
  blocked: null,
})
const dueText = () =>
  [...document.querySelectorAll('.task-field')]
    .find((f) => f.querySelector('.task-field-label')?.textContent === 'Due')
    ?.querySelector('.task-field-value')?.textContent

describe('the task window on a task the workspace does not hold', { timeout: 30_000 }, () => {
  it('shows each state of its read apart', async () => {
    await load()
    const handle = await noteTask(far())
    await openWindow(handle)
    // opened by its reference and never shown, before the read answers:
    // its key, and no title the server did not send
    expect(note()?.textContent).toBe('Loading QN-40…')
    expect(document.querySelector('[data-task-gone-task]')?.textContent).toBe('QN-40')
    expect(document.querySelector('[data-task-gone]')?.hasAttribute('data-task-loading')).toBe(true)
    expect(one('taskWindow:task').args).toEqual({ org_id: snap.orgs[0].id, ref: FAR })
    // a failed read, with Retry, which reads it again
    await act(async () => one('taskWindow:task').fail(new Error('Server Error')))
    expect(note()?.textContent).toBe("Couldn't open QN-40.")
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

  it('edits a task from its answer, each write sending the values the window showed', async () => {
    await load()
    const handle = await noteTask(far())
    await openWindow(handle)
    await answer(
      'taskWindow:task',
      okAnswer(far(), { follow: { issue_id: FAR, profile_id: 'mira', created_at: AT } }),
    )
    await answer('snapshot:threadComments', {
      comments: [comment('c-1', FAR, 'mira', 'Measured at one metre')],
      earlier: false,
    })
    expect(dialog()?.dataset.taskSource).toBe('answer')
    for (const label of ['Status', 'Priority', 'Assignee', 'Reviewer'])
      expect(field(label)?.disabled, label).toBe(false)
    const update = () => sentArgs('issues:update').at(-1)
    // the title, from the one it began from
    await click(document.querySelector('[data-task-title]'))
    const title = document.querySelector<HTMLTextAreaElement>('[aria-label="Task title"]')
    if (!title) throw new Error('the title field did not open')
    await typeInto(title, 'Tune the antenna twice')
    await act(async () => title.blur())
    expect(update()).toEqual({
      org_id: snap.orgs[0].id,
      id: FAR,
      patch: { title: 'Tune the antenna twice' },
      expected: { title: printOf(trimmedForm('Tune the antenna')) },
    })
    expect(document.querySelector('[data-task-title]')?.textContent).toBe('Tune the antenna twice')
    // the description, through its editor's Save
    const description = await editorOf('Task description')
    await act(async () => description.chain().focus('end').insertContent(' Twice.').run())
    await click(buttonNamed('Save'))
    expect(update()).toMatchObject({
      patch: { description: 'Measure the gain at **three** heights. Twice.' },
      expected: { description: printOf(descriptionForm('Measure the gain at **three** heights.')) },
    })
    // Remaining, as it blurs
    const remaining = document.querySelector<HTMLInputElement>('[data-remaining-input]')
    if (!remaining) throw new Error('missing the Remaining field')
    expect(remaining.disabled).toBe(false)
    await act(async () => remaining.focus())
    await typeInto(remaining, '12')
    await act(async () => remaining.blur())
    expect(update()).toMatchObject({
      patch: { remaining_hours: 12 },
      expected: { remaining_hours: 400 },
    })
    // the due date, from its calendar
    const due = [...document.querySelectorAll('.task-field')]
      .find((f) => f.querySelector('.task-field-label')?.textContent === 'Due')
      ?.querySelector<HTMLButtonElement>('[data-field-trigger]')
    expect(due?.disabled).toBe(false)
    await click(due)
    const pick = [...document.querySelectorAll<HTMLButtonElement>('[data-cal-day]')].find(
      (b) => b.dataset.calDay !== day(14) && !b.disabled,
    )
    await click(pick)
    expect(update()).toMatchObject({
      patch: { due_date: pick?.dataset.calDay },
      expected: { due_date: day(14) },
    })
    // a label, from the picker, which lists the server's batch
    network.query.mockImplementation(async (ref, args) =>
      getFunctionName(ref) === 'labels:picker' ? labelPickerStandIn(snap, args) : null,
    )
    await click(document.querySelector('button[aria-label="Add label"]'))
    await nextFrame()
    await click(buttonNamed('Hardware'))
    expect(sentArgs('labels:toggle')).toEqual([
      { org_id: snap.orgs[0].id, issue_id: FAR, label_id: 'label-1', on: true },
    ])
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    // Plan on roadmap, for a task from a current answer
    const roadmap = document.querySelector<HTMLButtonElement>('[data-plan-on-roadmap]')
    expect(roadmap?.disabled).toBe(false)
    // the relations change from the answer too (the next case)
    expect(dialog()?.textContent).toContain('No parent task.')
    for (const control of relationButtons())
      expect(control?.disabled, control?.getAttribute('aria-label') ?? '').toBe(false)
    // the composer stays
    expect(document.querySelector('[data-composer]')).not.toBeNull()
    // Move and Archive or delete open, from the answer's whole subtask list
    await act(async () =>
      document.querySelector<HTMLElement>('[aria-label="Task actions"]')?.focus(),
    )
    const item = await taskActions()
    for (const text of ['Move to sub-project…', 'Archive or delete…']) {
      const control = item(text)
      expect(control instanceof HTMLButtonElement && control.disabled, text).toBe(false)
    }
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    // the eye follows, and opens Subscribers from the answer
    const eye = document.querySelector<HTMLButtonElement>('[data-task-subscribe]')
    expect(eye?.dataset.taskSubscribe).toBe('on')
    expect(eye?.disabled).toBe(false)
    await click(eye)
    expect(document.querySelector('[data-task-subscribers]')).not.toBeNull()
    expect(one('issues:subscribers').args).toEqual({ org_id: snap.orgs[0].id, issue_id: FAR })
  })

  it('changes the parent, subtasks and links of a task shown from its answer, sending what the window showed', async () => {
    await load()
    const held = holdRelations()
    const handle = await noteTask(far())
    await openWindow(handle)
    await answer('taskWindow:task', okAnswer(far()))
    const org = snap.orgs[0].id
    // Set parent reads the Parent picker's batch for this task
    await click(document.querySelector('[aria-label="Set parent"]'))
    await nextFrame()
    expect(held.at(-1)?.args).toEqual({ org_id: org, issue_id: FAR, kind: 'parent' })
    const mast = pickerRow(task(PICKED, 44, { title: 'Build the mast' }))
    await held.at(-1)?.answer(pickerBatch([mast]))
    await click(document.querySelector(`[data-picker-row="${PICKED}"]`))
    expect(sentArgs('issues:update').at(-1)).toEqual({
      org_id: org,
      id: FAR,
      patch: { parent_id: PICKED },
      expected: { parent_id: null, has_hidden_parent: false },
    })
    // the Parent row shows the new parent at once
    const parentRow = document.querySelector(`[data-related-task="QN-44"]`)
    expect(parentRow?.textContent).toContain('Build the mast')
    // a later answer: no parent, and a subtask the workspace does not hold
    const kid = task(FAR_KID, 42, { title: 'Mount the antenna', parent_id: FAR })
    await answer(
      'taskWindow:task',
      okAnswer(far(), { subtasks: { rows: [short(kid)], complete: true } }),
    )
    // a subtask's × detaches it from the row as the window showed it
    const remove = document.querySelector<HTMLButtonElement>(
      '[data-section="subtasks"] [data-related-task="QN-42"] .task-related-remove',
    )
    expect(remove?.disabled).toBe(false)
    await click(remove)
    expect(sentArgs('issues:update').at(-1)).toEqual({
      org_id: org,
      id: FAR_KID,
      patch: { parent_id: null },
      expected: { parent_id: FAR, has_hidden_parent: false },
    })
    expect(
      document.querySelector('[data-section="subtasks"] [data-related-task="QN-42"]'),
    ).toBeNull()
    // Link task links a task the picker offered, in the stored form
    await click(document.querySelector('[aria-label="Link task"]'))
    await nextFrame()
    expect(held.at(-1)?.args).toEqual({ org_id: org, issue_id: FAR, kind: 'link' })
    await held.at(-1)?.answer(pickerBatch([pickerRow(task(PICKED_2, 45, { title: 'Wire it' }))]))
    await click(document.querySelector(`[data-picker-row="${PICKED_2}"]`))
    expect(sentArgs('issues:addLink').at(-1)).toMatchObject({
      org_id: org,
      source_id: PICKED_2,
      target_id: FAR,
      type: 'blocks',
    })
  })

  it('picks a subtask with the parent its row showed and takes off a link with the kind its list showed, for a task shown from its answer', async () => {
    await load()
    const held = holdRelations()
    network.mutation.mockImplementation(() => new Promise(() => {}))
    await openWindow(await noteTask(far()))
    await answer('taskWindow:task', okAnswer(far()))
    // a link that blocks this task, to a task the workspace does not hold
    const blocker = task(PICKED_2, 45, { title: 'Wire it' })
    await answer('taskWindow:links', {
      state: 'ok',
      links: [
        { id: 'link-far', source_id: PICKED_2, target_id: FAR, type: 'blocks', created_at: AT },
      ],
      tasks: [short(blocker)],
      complete: true,
    })
    const org = snap.orgs[0].id
    // Add subtask offers a task that is another task's subtask today
    await click(document.querySelector('[aria-label="Add subtask"]'))
    await nextFrame()
    expect(held.at(-1)?.args).toEqual({ org_id: org, issue_id: FAR, kind: 'subtask' })
    const cable = pickerRow(task(PICKED_3, 46, { title: 'Coil the cable' }))
    await held.at(-1)?.answer(pickerBatch([{ ...cable, parent_id: FAR_KID_2 }]))
    await click(document.querySelector(`[data-picker-row="${PICKED_3}"]`))
    // the move, with the parent the row showed as the one expected
    expect(sentArgs('issues:update').at(-1)).toEqual({
      org_id: org,
      id: PICKED_3,
      patch: { parent_id: FAR },
      expected: { parent_id: FAR_KID_2, has_hidden_parent: false },
    })
    // the window's Subtasks list shows it at once
    expect(
      document.querySelector('[data-section="subtasks"] [data-related-task="QN-46"]'),
    ).not.toBeNull()
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    expect(document.querySelector('[data-relation-picker]')).toBeNull()
    // Link task lists the current link first, checked, and a press takes it off
    await click(document.querySelector('[aria-label="Link task"]'))
    await nextFrame()
    expect(held.at(-1)?.args).toEqual({ org_id: org, issue_id: FAR, kind: 'link' })
    await held.at(-1)?.answer(pickerBatch([]))
    const current = document.querySelector<HTMLElement>(
      `[data-picker-row="${PICKED_2}"][data-picker-current]`,
    )
    expect(current?.getAttribute('aria-pressed')).toBe('true')
    await click(current)
    // with the relation the list showed, seen from this task
    expect(sentArgs('issues:removeLink')).toEqual([
      { org_id: org, a: FAR, b: PICKED_2, expected: { kind: 'blocked_by' } },
    ])
  })

  it('keeps a current subtask checked and locked in the Subtasks picker once access to it drops while the picker is open', async () => {
    await load()
    const held = holdRelations()
    await openWindow(await noteTask(far()))
    const kid = task(FAR_KID, 42, { title: 'Mount the antenna', parent_id: FAR })
    const withKid = (level: string) =>
      okAnswer(far(), { subtasks: { rows: [{ ...short(kid), level }], complete: true } })
    await answer('taskWindow:task', withKid('lead'))
    await click(document.querySelector('[aria-label="Add subtask"]'))
    await nextFrame()
    await held.at(-1)?.answer(pickerBatch([]))
    const rowOf = () => document.querySelector<HTMLButtonElement>(`[data-picker-row="${FAR_KID}"]`)
    expect(rowOf()?.dataset.pickerCurrent).toBe('')
    expect(rowOf()?.getAttribute('aria-pressed')).toBe('true')
    expect(rowOf()?.disabled).toBe(false)
    // the window's next answer says Mira only views QN-42's project now
    await answer('taskWindow:task', withKid('viewer'))
    // it is still a subtask, so it stays checked, and takes no press
    expect(rowOf()?.dataset.pickerCurrent).toBe('')
    expect(rowOf()?.getAttribute('aria-pressed')).toBe('true')
    expect(rowOf()?.disabled).toBe(true)
    await click(rowOf())
    expect(sentArgs('issues:update')).toEqual([])
  })

  it('keeps a link that only its Edit on the task takes off listed, checked and locked, while the read of a task shown from its answer fails', async () => {
    await load()
    const held = holdRelations()
    await openWindow(await noteTask(far()))
    await answer('taskWindow:task', okAnswer(far()))
    // a link to a task in Manuals, which Mira only views, so only her Edit
    // on this task takes it off
    const manual = task(PICKED_2, 45, { title: 'Proof the manual', project_id: 'manuals' })
    await answer('taskWindow:links', {
      state: 'ok',
      links: [
        { id: 'link-ro', source_id: FAR, target_id: PICKED_2, type: 'relates', created_at: AT },
      ],
      tasks: [short(manual)],
      complete: true,
    })
    await click(document.querySelector('[aria-label="Link task"]'))
    await nextFrame()
    await held.at(-1)?.answer(pickerBatch([]))
    const rowOf = () => document.querySelector<HTMLButtonElement>(`[data-picker-row="${PICKED_2}"]`)
    expect(rowOf()?.dataset.pickerCurrent).toBe('')
    expect(rowOf()?.getAttribute('aria-pressed')).toBe('true')
    expect(rowOf()?.disabled).toBe(false)
    // the window's read fails, so Qivo cannot check the task for changes
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => one('taskWindow:task').fail(new Error('Server Error')))
    expect(document.querySelector<HTMLElement>('[data-task-stale]')?.dataset.taskStale).toBe(
      'failed',
    )
    // the link stays current and checked, without a press
    expect(rowOf()?.dataset.pickerCurrent).toBe('')
    expect(rowOf()?.getAttribute('aria-pressed')).toBe('true')
    expect(rowOf()?.disabled).toBe(true)
  })

  it('offers a Viewer of a task shown from its answer only Link task, to a task they can edit', async () => {
    await load()
    holdRelations()
    const row = task(FAR_RO, 41, { title: 'Read the far manual', project_id: 'manuals' })
    await openWindow(await noteTask(row))
    await answer('taskWindow:task', okAnswer(row))
    const [parent, subtask, link] = relationButtons()
    for (const control of [parent, subtask]) {
      expect(control?.disabled, control?.getAttribute('aria-label') ?? '').toBe(true)
      expect(await hintOf(control)).toBe(READ_ONLY)
    }
    expect(link?.disabled).toBe(false)
  })

  it('waits with the check sentence while its read fails, keeping comments and a typed title', async () => {
    await load()
    await openWindow(await noteTask(far()))
    await answer('taskWindow:task', okAnswer(far()))
    await answer('snapshot:threadComments', { comments: [], earlier: false })
    await click(document.querySelector('[data-task-title]'))
    const title = document.querySelector<HTMLTextAreaElement>('[aria-label="Task title"]')
    if (!title) throw new Error('the title field did not open')
    await typeInto(title, 'Tune the antenna twice')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => one('taskWindow:task').fail(new Error('Server Error')))
    expect(document.querySelector<HTMLElement>('[data-task-stale]')?.dataset.taskStale).toBe(
      'failed',
    )
    // the title stays, and its save waits with the reason
    await act(async () => title.blur())
    expect(window.showToast).toHaveBeenCalledWith(STALE_SAVE, 'error')
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Task title"]')?.value).toBe(
      'Tune the antenna twice',
    )
    // an image pasted into the description waits with the reason too, and
    // never shows as uploading
    const description = await editorOf('Task description')
    const changes = vi.fn()
    description.on('update', changes)
    window.showToast = vi.fn()
    const image = new File(['png'], 'photo.png', { type: 'image/png' })
    const paste = {
      clipboardData: { files: [image], getData: () => '' },
      preventDefault: () => {},
    } as unknown as ClipboardEvent
    await act(async () => {
      description.view.pasteHTML('', paste)
    })
    expect(changes).not.toHaveBeenCalled()
    expect(window.showToast).toHaveBeenCalledWith(STALE_SAVE, 'error')
    expect(sentArgs('files:uploadUrl')).toEqual([])
    for (const label of ['Status', 'Priority', 'Assignee']) {
      expect(field(label)?.disabled, label).toBe(true)
      expect(await hintOf(field(label)), label).toBe(WAITS_FOR_CHECK)
    }
    const eye = document.querySelector<HTMLButtonElement>('[data-task-subscribe]')
    expect(eye?.disabled).toBe(true)
    expect(await hintOf(eye)).toBe(WAITS_FOR_CHECK)
    const roadmap = document.querySelector<HTMLButtonElement>('[data-plan-on-roadmap]')
    expect(roadmap?.disabled).toBe(true)
    expect(await hintOf(roadmap)).toBe(WAITS_FOR_CHECK)
    // the relation changes wait the same way, Link task included
    for (const control of relationButtons()) {
      expect(control?.disabled, control?.getAttribute('aria-label') ?? '').toBe(true)
      expect(await hintOf(control)).toBe(WAITS_FOR_CHECK)
    }
    // comments still work
    expect(document.querySelector('[data-composer]')).not.toBeNull()
    await act(async () =>
      document.querySelector<HTMLElement>('[aria-label="Task actions"]')?.focus(),
    )
    const item = await taskActions()
    for (const text of ['Move to sub-project…', 'Archive or delete…']) {
      const control = item(text)
      expect(control instanceof HTMLButtonElement && control.disabled, text).toBe(true)
      expect(await hintOf(control), text).toBe(WAITS_FOR_CHECK)
    }
    expect(sentArgs('issues:update')).toEqual([])
  })

  it('shows a task whose subtask list is not whole as a group, with its own fields still editable', async () => {
    await load()
    await openWindow(await noteTask(far()))
    const kid = short(task(FAR_KID, 42, { parent_id: FAR }))
    await answer(
      'taskWindow:task',
      okAnswer(far(), {
        task: { ...far(), has_subtasks: true, has_hidden_subtasks: true },
        subtasks: { rows: [kid], complete: false },
      }),
    )
    // a group: no status or reviewer of its own
    expect(field('Status')).toBeNull()
    expect(field('Reviewer')).toBeNull()
    for (const label of ['Priority', 'Assignee']) expect(field(label)?.disabled, label).toBe(false)
    expect(document.querySelector('button[aria-label="Add label"]')).not.toBeNull()
    expect(buttonNamed('browse')).toBeDefined()
    // what Move and Archive or delete take along is unknown
    const item = await taskActions()
    for (const text of ['Move to sub-project…', 'Archive or delete…']) {
      const control = item(text)
      expect(control instanceof HTMLButtonElement && control.disabled, text).toBe(true)
      expect(await hintOf(control), text).toBe(FAMILY_UNKNOWN)
    }
  })

  it('says it cannot read every subtask where a whole list holds a group stored before the rule of one level', async () => {
    await load()
    await openWindow(await noteTask(far()))
    await answer(
      'taskWindow:task',
      okAnswer(far(), {
        task: { ...far(), has_subtasks: true },
        subtasks: { rows: [short(task(FAR_KID, 42, { parent_id: FAR }), true)], complete: true },
      }),
    )
    const item = await taskActions()
    for (const text of ['Move to sub-project…', 'Archive or delete…']) {
      const control = item(text)
      expect(control instanceof HTMLButtonElement && control.disabled, text).toBe(true)
      expect(await hintOf(control), text).toBe(FAMILY_UNKNOWN)
    }
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
    // the Roadmap opens a task of a project the person views
    const roadmap = document.querySelector<HTMLButtonElement>('[data-plan-on-roadmap]')
    expect(roadmap?.disabled).toBe(false)
    // the eye follows from the answer, which needs only sight
    expect(document.querySelector<HTMLButtonElement>('[data-task-subscribe]')?.disabled).toBe(false)
    expect(document.querySelector('[data-composer]')).toBeNull()
    // an author edits their own comment; a viewer no one else's
    expect(
      document.querySelector('[data-comment="c-1"] [aria-label="Edit comment"]'),
    ).not.toBeNull()
    expect(document.querySelector('[data-comment="c-2"] [aria-label^="Edit comment"]')).toBeNull()
    const item = await taskActions()
    expect(item('Archive or delete…')).toBeUndefined()
  })

  it('turns Plan on roadmap off for a Done task without dates, saying why, and on once it has dates', async () => {
    await load()
    const row = far({ status: 'done' })
    await openWindow(await noteTask(row))
    await answer('taskWindow:task', okAnswer(row))
    const roadmap = () => document.querySelector<HTMLButtonElement>('[data-plan-on-roadmap]')
    expect(roadmap()?.textContent).toBe('Plan on roadmap')
    expect(roadmap()?.disabled).toBe(true)
    expect(await hintOf(roadmap())).toBe(
      'A Done task without dates has nothing to plan on the Roadmap.',
    )
    // the same task once someone gives it dates
    const { TODAY_WEEK, weekToISO } = await import('../lib/dates')
    await answer(
      'taskWindow:task',
      okAnswer({ ...row, start_week: weekToISO(TODAY_WEEK), end_week: weekToISO(TODAY_WEEK + 1) }),
    )
    expect(roadmap()?.disabled).toBe(false)
    expect(await hintOf(roadmap())).toBeNull()
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

  it('turns to the workspace’s view in place when the task arrives, keeping a title and a comment typed meanwhile', async () => {
    await load(true)
    const handle = await noteTask(far())
    await openWindow(handle)
    await answer('taskWindow:task', okAnswer(far()))
    await answer('snapshot:threadComments', { comments: [], earlier: false })
    expect(field('Priority')?.disabled).toBe(false)
    const composer = await editorOf('Leave a comment')
    await act(async () => composer.commands.insertContent('Gain looks low'))
    await click(document.querySelector('[data-task-title]'))
    const title = document.querySelector<HTMLTextAreaElement>('[aria-label="Task title"]')
    if (!title) throw new Error('the title field did not open')
    await typeInto(title, 'Tune the antenna twice')
    await arrive()
    expect(dialog()?.dataset.taskSource).toBe('workspace')
    expect(field('Priority')?.disabled).toBe(false)
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Task title"]')?.value).toBe(
      'Tune the antenna twice',
    )
    expect((await editorOf('Leave a comment')).getText()).toBe('Gain looks low')
    expect(composer.isDestroyed).toBe(false)
    // the read stops with no section to read it for; the details column's
    // sections ask afresh
    expect(open('taskWindow:task')).toHaveLength(1)
  })

  it('offers no relation change over a number address until the task side answers, then offers them', async () => {
    await load()
    holdRelations()
    const { taskRef } = await import('../lib/taskReference')
    const org = snap.orgs[0].id
    await openWindow(taskRef({ org, num: 40 }))
    // the read of the reference by its number serves the window first
    const byNumber = one('taskWindow:task')
    expect(byNumber.args).toEqual({ org_id: org, ref: 'QN-40' })
    await act(async () => byNumber.deliver(okAnswer(far())))
    expect(document.querySelector('[data-task-title]')?.textContent).toBe('Tune the antenna')
    // the task side reads it by its uuid, and until it answers the window
    // takes no relation change, Link task included
    const side = open('taskWindow:task').find((s) => s.args.ref === FAR)
    expect(side?.args).toEqual({ org_id: org, ref: FAR })
    for (const control of relationButtons()) {
      expect(control?.disabled, control?.getAttribute('aria-label') ?? '').toBe(true)
      expect(await hintOf(control)).toBe(WAITS_FOR_CHECK)
    }
    await act(async () => side?.deliver(okAnswer(far())))
    for (const control of relationButtons())
      expect(control?.disabled, control?.getAttribute('aria-label') ?? '').toBe(false)
  })

  it('keeps a relation picker open with its rows and a pick on its way when the task arrives', async () => {
    await load(true)
    const held = holdRelations()
    network.mutation.mockImplementation(() => new Promise(() => {}))
    const handle = await noteTask(far())
    await openWindow(handle)
    await answer('taskWindow:task', okAnswer(far()))
    await click(document.querySelector('[aria-label="Link task"]'))
    await nextFrame()
    // the picker reads once it mounts, a frame after the press
    await act(async () => {
      await vi.waitFor(() => expect(held).toHaveLength(1))
    })
    await held[0]?.answer(pickerBatch([pickerRow(task(PICKED, 44, { title: 'Wire it' }))]))
    const row = () => document.querySelector<HTMLElement>(`[data-picker-row="${PICKED}"]`)
    await act(async () => {
      await vi.waitFor(() => expect(row()).not.toBeNull())
    })
    await click(row())
    expect(row()?.dataset.pickerBusy).toBe('')
    await arrive()
    await act(async () => {
      await vi.waitFor(() => expect(dialog()?.dataset.taskSource).toBe('workspace'))
    })
    // the same picker, its rows and its busy row, with no read again
    expect(row()?.dataset.pickerBusy).toBe('')
    expect(row()?.getAttribute('aria-pressed')).toBe('true')
    expect(held).toHaveLength(1)
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
    // by a reference that names its organization, number and uuid
    const ref = await noteTask(kidRow)
    expect(onOpen).toHaveBeenCalledWith(ref)
    // the window reads it, in its organization
    expect(one('taskWindow:task').args).toEqual({ org_id: snap.orgs[0].id, ref: FAR_KID })
    const { buildPath, issueLink } = await import('../lib/router')
    expect(buildPath({ view: 'kanban', openIssue: ref })).toBe('/app/testbed/board/tasks/qn-42')
    expect(issueLink(ref)).toBe('/app/testbed/tasks/qn-42')
    await answer('taskWindow:task', okAnswer(kidRow, { parent: short(snap.issues[0], true) }))
    expect(document.querySelector('[data-task-title]')?.textContent).toBe('Wind the coil')
    // its Parent row is the held family task
    expect(document.querySelector('[data-related-task="QN-27"]')?.textContent).toContain(
      'Calibrate the sensor',
    )
  })

  it('keeps All, the Details tab and a title typed when the reference it opened by turns into its handle', async () => {
    viewport(true)
    await load(true)
    const ref = await noteTask(far())
    await openWindow(ref)
    await answer('taskWindow:task', okAnswer(far()))
    // All under Activity reads the history, and the Details tab the lists
    await click(buttonNamed('All'))
    expect(open('snapshot:threadHistory')).toHaveLength(1)
    await click(buttonNamed('Details'))
    expect(open('taskWindow:links')).toHaveLength(1)
    await click(document.querySelector('[data-task-title]'))
    const title = document.querySelector<HTMLTextAreaElement>('[aria-label="Task title"]')
    if (!title) throw new Error('the title field did not open')
    await typeInto(title, 'Tune the antenna twice')
    // the workspace brings the task, and the reference turns into its handle
    await arrive()
    expect(shownHandle).toBe('QN-40')
    expect(dialog()?.dataset.taskSource).toBe('workspace')
    // the same window, as it was
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Task title"]')?.value).toBe(
      'Tune the antenna twice',
    )
    expect(open('snapshot:threadHistory')).toHaveLength(1)
    expect(open('taskWindow:links')).toHaveLength(1)
    expect(window.showToast).not.toHaveBeenCalledWith('Unsaved title discarded')
  })

  it('keeps the remaining hours typed when the reference it opened by turns into its handle', async () => {
    await load(true)
    await openWindow(await noteTask(far()))
    await answer('taskWindow:task', okAnswer(far()))
    const remaining = document.querySelector<HTMLInputElement>('[data-remaining-input]')
    if (!remaining) throw new Error('missing the Remaining field')
    await act(async () => remaining.focus())
    await typeInto(remaining, '12')
    await arrive()
    expect(shownHandle).toBe('QN-40')
    expect(dialog()?.dataset.taskSource).toBe('workspace')
    expect(document.querySelector<HTMLInputElement>('[data-remaining-input]')?.value).toBe('12')
    expect(document.activeElement).toBe(document.querySelector('[data-remaining-input]'))
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
    // and every other control: read-only where the workspace says so
    for (const label of ['Status', 'Priority', 'Assignee']) {
      expect(field(label)?.disabled, label).toBe(true)
      expect(await hintOf(field(label)), label).toBe(READ_ONLY)
    }
    expect(document.querySelector('button[aria-label="Add label"]')).toBeNull()
    expect(document.querySelector<HTMLInputElement>('[data-remaining-input]')?.disabled).toBe(true)
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
    // the answer's word holds for the fields too, and the eye needs sight
    for (const label of ['Status', 'Priority', 'Assignee']) {
      expect(field(label)?.disabled, label).toBe(true)
      expect(await hintOf(field(label)), label).toBe(READ_ONLY)
    }
    expect(document.querySelector('button[aria-label="Add label"]')).toBeNull()
    expect(document.querySelector<HTMLButtonElement>('[data-task-subscribe]')?.disabled).toBe(false)
    await answer('taskWindow:task', archivedAnswer(far(), 'viewer'))
    expect(buttonNamed('Restore')).toBeUndefined()
    // both agree: all of them
    await answer('taskWindow:task', okAnswer(far()))
    expect(document.querySelector('[data-composer]')).not.toBeNull()
    expect(leadEdit()).not.toBeNull()
    for (const label of ['Status', 'Priority', 'Assignee'])
      expect(field(label)?.disabled, label).toBe(false)
    expect(document.querySelector('button[aria-label="Add label"]')).not.toBeNull()
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

  it('keeps a title typed for a task that leaves the workspace, and saves it through an answer that gives Edit', async () => {
    await load()
    await openWindow('QN-27')
    await answer('taskWindow:task', okAnswer(fam()))
    await click(document.querySelector('[data-task-title]'))
    const title = document.querySelector<HTMLTextAreaElement>('[aria-label="Task title"]')
    if (!title) throw new Error('the title field did not open')
    await typeInto(title, 'Calibrate the sensor twice')
    await act(async () => publish(withoutFam()))
    expect(dialog()?.dataset.taskSource).toBe('answer')
    const kept = document.querySelector<HTMLTextAreaElement>('[aria-label="Task title"]')
    expect(kept?.value).toBe('Calibrate the sensor twice')
    expect(window.showToast).not.toHaveBeenCalledWith('Unsaved title discarded')
    await act(async () => kept?.blur())
    expect(sentArgs('issues:update')).toEqual([
      {
        org_id: snap.orgs[0].id,
        id: FAM,
        patch: { title: 'Calibrate the sensor twice' },
        expected: { title: printOf(trimmedForm('Calibrate the sensor')) },
      },
    ])
  })

  it('discards a title typed for a task that leaves the workspace when its answer gives no Edit', async () => {
    await load()
    await openWindow('QN-27')
    await answer('taskWindow:task', okAnswer(fam(), { level: 'viewer' }))
    await click(document.querySelector('[data-task-title]'))
    const title = document.querySelector<HTMLTextAreaElement>('[aria-label="Task title"]')
    if (!title) throw new Error('the title field did not open')
    await typeInto(title, 'Calibrate the sensor twice')
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

describe('an image pasted into a description shown from its answer', { timeout: 30_000 }, () => {
  const STILL_UPLOADING = 'An image is still uploading. The description saves once it has finished.'
  const image = () => new File(['png'], 'photo.png', { type: 'image/png' })
  /* Pastes `file` into the description `editor`, as a person does. */
  const paste = (editor: Awaited<ReturnType<typeof editorOf>>, file: File) =>
    act(async () => {
      editor.view.pasteHTML('', {
        clipboardData: { files: [file], getData: () => '' },
        preventDefault: () => {},
      } as unknown as ClipboardEvent)
    })
  /* The family task as the workspace holds it, and a delivery of the
     workspace without it. */
  const fam = () => {
    const row = snap.issues.find((t) => t.id === FAM)
    if (!row) throw new Error('missing the family task')
    return row
  }
  const withoutFam = () => {
    const left = structuredClone(snap)
    left.issues = left.issues.filter((t) => t.id !== FAM)
    return left
  }
  /* Holds the upload's URL until `finish` or `fail` lets it go, and answers
     its attach with the row the server stores and every other write with
     null. `finish` answers the attachment's id. The image's address is
     minted without one, so it shows as unavailable. */
  function holdUpload() {
    const upload: { resolve?: (url: string) => void; reject?: (error: unknown) => void } = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ storageId: 'st-1' }) })),
    )
    network.query.mockImplementation((ref) =>
      Promise.resolve(
        getFunctionName(ref) === 'files:mintUrls' ? { attachments: {}, avatars: {} } : null,
      ),
    )
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (name === 'files:uploadUrl')
        return new Promise((resolve, reject) => Object.assign(upload, { resolve, reject }))
      if (name === 'files:attach')
        return Promise.resolve({
          attachment: {
            id: args.id,
            issue_id: args.issue_id,
            name: args.name,
            mime: args.mime,
            size_bytes: 3,
            storage_id: 'st-1',
            inline: true,
            created_at: AT,
          },
        })
      return Promise.resolve(null)
    })
    const asked = () =>
      vi.waitFor(() => {
        if (!upload.resolve) throw new Error('the upload has not asked for its URL')
      })
    const settle = (step: () => void) =>
      act(async () => {
        step()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    return {
      asked,
      finish: async () => {
        await asked()
        await settle(() => upload.resolve?.('https://convex.example/upload'))
        const attach = await vi.waitFor(() => {
          const found = sentArgs('files:attach').at(-1)
          if (!found) throw new Error('the upload did not attach')
          return found
        })
        await settle(() => {})
        return String(attach.id)
      },
      fail: async () => {
        await asked()
        await settle(() => upload.reject?.(new Error('Server Error')))
      },
    }
  }
  /* The descriptions the window saved, in order. */
  const descriptions = () =>
    sentArgs('issues:update').map(({ patch }) =>
      String((patch as { description?: string }).description),
    )
  /* Whether description `text` holds the image `attId`, the words typed
     with it, and no placeholder. */
  const holdsImage = (text: string | undefined, attId: string) =>
    !!text?.includes(`(att:${attId})`) && text.includes('Twice.') && !text.includes('uploading:')

  it('waits to save until the image has uploaded, then saves it once with the image', async () => {
    await load()
    await openWindow(await noteTask(far()))
    await answer('taskWindow:task', okAnswer(far()))
    const upload = holdUpload()
    const description = await editorOf('Task description')
    await act(async () => description.chain().focus('end').insertContent(' Twice.').run())
    await paste(description, image())
    await upload.asked()
    await click(buttonNamed('Save'))
    expect(window.showToast).toHaveBeenCalledWith(STILL_UPLOADING, 'error')
    expect(descriptions()).toEqual([])
    const attId = await upload.finish()
    expect(descriptions()).toHaveLength(1)
    expect(holdsImage(descriptions()[0], attId)).toBe(true)
  })

  it('saves a waiting draft once, with its image, when the task left the workspace while it uploaded', async () => {
    await load()
    await openWindow('QN-27')
    await answer('taskWindow:task', okAnswer(fam()))
    const upload = holdUpload()
    const description = await editorOf('Task description')
    await paste(description, image())
    await upload.asked()
    // saved while the workspace holds the task, with the image uploading
    await click(buttonNamed('Save'))
    const saved = descriptions()[0] ?? ''
    expect(saved).toContain('](uploading:')
    // the task leaves the workspace, and its answer holds that save
    await act(async () => publish(withoutFam()))
    await answer('taskWindow:task', okAnswer({ ...fam(), description: saved }))
    expect(dialog()?.dataset.taskSource).toBe('answer')
    // more is typed and saved while the image still uploads, which waits
    await act(async () => description.chain().focus('end').insertContent(' Twice.').run())
    await click(buttonNamed('Save'))
    expect(window.showToast).toHaveBeenCalledWith(STILL_UPLOADING, 'error')
    expect(descriptions()).toHaveLength(1)
    const attId = await upload.finish()
    // the upload saves the waiting draft, and patches nothing over it
    expect(descriptions()).toHaveLength(2)
    expect(holdsImage(descriptions()[1], attId)).toBe(true)
  })

  it('removes an image whose draft was discarded, in the task’s organization, though the window closed before it uploaded', async () => {
    await load()
    await openWindow(await noteTask(far()))
    await answer('taskWindow:task', okAnswer(far()))
    const upload = holdUpload()
    const description = await editorOf('Task description')
    await paste(description, image())
    await upload.asked()
    await click(buttonNamed('Discard changes'))
    await act(async () => root.render(<TooltipProvider>{null}</TooltipProvider>))
    expect(open('taskWindow:task')).toEqual([])
    const attId = await upload.finish()
    expect(descriptions()).toEqual([])
    expect(sentArgs('files:removeAttachment')).toEqual([{ org_id: snap.orgs[0].id, id: attId }])
  })

  it('saves a waiting draft without the image when its upload fails', async () => {
    await load()
    await openWindow(await noteTask(far()))
    await answer('taskWindow:task', okAnswer(far()))
    const upload = holdUpload()
    const description = await editorOf('Task description')
    await act(async () => description.chain().focus('end').insertContent(' Twice.').run())
    await paste(description, image())
    await upload.asked()
    await click(buttonNamed('Save'))
    expect(descriptions()).toEqual([])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await upload.fail()
    expect(descriptions()).toHaveLength(1)
    expect(descriptions()[0]).toContain('Measure the gain at **three** heights. Twice.')
    expect(descriptions()[0]).not.toMatch(/uploading:|att:/)
    expect(sentArgs('files:attach')).toEqual([])
  })
})

describe('the task window when the home organization changes', { timeout: 30_000 }, () => {
  const BETA = 'org-beta'
  /* Mira also holds a seat in Beta, which holds its own QN-40. */
  const withBeta = (next: Snapshot) => {
    const org = next.orgs[0]
    next.orgs.push({ ...org, id: BETA, slug: 'beta', name: 'Beta' })
    const mira = next.profiles.find((p) => p.id === 'mira')
    if (!mira) throw new Error('missing Mira')
    next.profiles.push({ ...mira, id: 'mira-beta', org_id: BETA, org_role: 'user' })
    next.myProfileIds.push('mira-beta')
    const work = next.projects.find((p) => p.id === 'work')
    if (!work) throw new Error('missing Work')
    next.projects.push(
      {
        ...work,
        id: 'beta-plan',
        org_id: BETA,
        type: 'meta',
        key: 'BP',
        num: 1,
        name: 'Beta plan',
        parent_id: undefined,
        lead_id: 'mira-beta',
      },
      {
        ...work,
        id: 'beta-work',
        org_id: BETA,
        key: 'BW',
        num: 2,
        name: 'Beta work',
        parent_id: 'beta-plan',
      },
    )
    next.issues.push(
      task('beta-40', 40, { org_id: BETA, project_id: 'beta-work', title: 'Beta task 40' }),
    )
  }

  for (const state of ['ok', 'archived'] as const)
    it(`keeps showing ${state === 'ok' ? 'a task from its answer' : 'an archived task'}, and its address names it, when the new home holds its number`, async () => {
      await load(false, withBeta)
      expect(P.homeOrg).toBe(snap.orgs[0].id)
      const ref = await noteTask(far())
      await openWindow(ref)
      expect(shownHandle).toBe(ref)
      await answer('taskWindow:task', state === 'ok' ? okAnswer(far()) : archivedAnswer(far()))
      const { buildPath, issueLink } = await import('../lib/router')
      const address = () => buildPath({ view: 'kanban', openIssue: shownHandle })
      expect(address()).toBe('/app/testbed/board/tasks/qn-40')
      // Mira's Testbed seat becomes a guest one: Beta is her home now,
      // where QN-40 is Beta's own task
      const next = structuredClone(snap)
      for (const p of next.profiles) if (p.id === 'mira') p.org_role = 'guest'
      await act(async () => publish(next))
      expect(P.homeOrg).toBe(BETA)
      expect(P.issueById['QN-40']?.title).toBe('Beta task 40')
      // the reference names its organization by id, so it does not move,
      // and the window goes on showing the task
      expect(shownHandle).toBe(ref)
      expect(document.querySelector('[data-task-title]')?.textContent).toBe('Tune the antenna')
      expect(dialog()?.dataset.taskSource).toBe('answer')
      expect(dialog()?.hasAttribute('data-task-archived')).toBe(state === 'archived')
      expect(one('taskWindow:task').args).toEqual({ org_id: snap.orgs[0].id, ref: FAR })
      // and the address and Copy link name it in Testbed
      expect(address()).toBe('/app/testbed/board/tasks/qn-40')
      expect(issueLink(FAR)).toBe('/app/testbed/tasks/qn-40')
    })

  it('keeps saying what became of a task that left, rather than show the new home task of its number', async () => {
    await load(false, (next) => {
      withBeta(next)
      next.issues.push(
        task('beta-27', 27, { org_id: BETA, project_id: 'beta-work', title: 'Beta task 27' }),
      )
    })
    await openWindow('QN-27')
    expect(dialog()?.dataset.taskSource).toBe('workspace')
    // someone deletes it: it leaves the board before its read answers
    const left = structuredClone(snap)
    left.issues = left.issues.filter((t) => t.id !== FAM)
    await act(async () => publish(left))
    expect(note()?.textContent).toBe('QN-27 is no longer on the board.')
    const { buildPath } = await import('../lib/router')
    for (const p of left.profiles) if (p.id === 'mira') p.org_role = 'guest'
    await act(async () => publish(left))
    expect(P.issueById['QN-27']?.title).toBe('Beta task 27')
    // the window follows it, saying the same of it, and its read answers
    expect(shownHandle).toBe(FAM)
    expect(note()?.textContent).toBe('QN-27 is no longer on the board.')
    await answer('taskWindow:task', { state: 'unavailable' })
    expect(note()?.textContent).toBe(
      'QN-27 is no longer here. It was deleted, or you can no longer open it.',
    )
    expect(document.querySelector('[data-task-title]')).toBeNull()
    expect(buildPath({ view: 'kanban', openIssue: shownHandle })).toBe(
      '/app/testbed/board/tasks/qn-27',
    )
  })
})

describe('the delay of a task the window cannot judge', { timeout: 30_000 }, () => {
  it("judges from the owner's load from the server while tasks load, and the workspace's verdict once they have", async () => {
    await load(true)
    const handle = await noteTask(far())
    await openWindow(handle)
    await answer('taskWindow:task', okAnswer(far()))
    // the window asks for the owner's other work, as a Board card does,
    // and shows no mark while it is on its way
    expect(one('planning:ownerLoads').args).toEqual({
      org_id: snap.orgs[0].id,
      owner_ids: ['mira'],
    })
    expect(delayChip()).toBeNull()
    // Delay unknown only where that work cannot be read
    await answer('planning:ownerLoads', {
      hidden: 'counted',
      owners: [{ owner_id: 'mira', state: 'unavailable' }],
    })
    expect(delayChip()?.dataset.delayChip).toBe('unknown')
    expect(delayChip()?.textContent).toBe('Delay unknown')
    expect(await hintOf(delayChip())).toBe("Qivo could not read the owner's other work.")
    // 400 hours do not fit in two weeks of Mira's time
    await answer('planning:ownerLoads', {
      hidden: 'counted',
      owners: [{ owner_id: 'mira', state: 'ok', spans: [] }],
    })
    expect(delayChip()?.dataset.delayChip).toBe('late')
    await arrive()
    // 400 hours do not fit in two weeks of Mira's time
    expect(delayChip()?.dataset.delayChip).toBe('late')
    expect(delayChip()?.textContent).toBe('Delayed')
  })

  it('says the delay of a held group is unknown while some of its subtasks load, naming them as the cause', async () => {
    // the family task is a group due in two weeks: one subtask ends within
    // a week, and one in three weeks, still to come
    await load(true, (next) => {
      const fam = next.issues.find((t) => t.id === FAM)
      Object.assign(fam ?? {}, { due_date: day(14), has_subtasks: true })
      next.issues.push(
        task('01000000-0000-4000-8000-000000000029', 29, {
          parent_id: FAM,
          start_week: day(0),
          end_week: day(7),
        }),
        task(FAR_KID, 42, { parent_id: FAM, start_week: day(0), end_week: day(21) }),
      )
    })
    // the workspace holds no task while every task loads; the group and its
    // near subtask held before the rest, as the person's own new tasks are
    const { __layerProbe } = await import('../store/planner')
    await act(async () =>
      __layerProbe?.plantTasks(
        snap.issues.filter((t) => t.id === FAM || t.id === '01000000-0000-4000-8000-000000000029'),
      ),
    )
    await openWindow(P.handleOf(FAM) ?? '')
    expect(dialog()?.dataset.taskSource).toBe('workspace')
    expect(delayChip()?.dataset.delayChip).toBe('unknown')
    expect(await hintOf(delayChip())).toBe(
      "Its subtasks' dates decide it, and they have not all loaded yet.",
    )
    // the subtask still to come ends after the due date
    await arrive()
    expect(delayChip()?.dataset.delayChip).toBe('late')
  })

  it('judges a group shown from its answer with hidden subtasks by its visible span, while tasks load too', async () => {
    await load(true)
    await openWindow(await noteTask(far()))
    const kid = short(task(FAR_KID, 42, { parent_id: FAR, start_week: day(0), end_week: day(7) }))
    await answer(
      'taskWindow:task',
      okAnswer(far(), {
        task: { ...far(), has_subtasks: true, has_hidden_subtasks: true },
        subtasks: { rows: [kid], complete: true },
      }),
    )
    expect(dialog()?.dataset.taskSource).toBe('answer')
    // hidden subtasks prove neither on track nor behind, loaded or not
    expect(delayChip()).toBeNull()
    // a visible span that ends past the due date proves it late
    const late = short(task(FAR_KID, 42, { parent_id: FAR, start_week: day(0), end_week: day(28) }))
    await answer(
      'taskWindow:task',
      okAnswer(far(), {
        task: { ...far(), has_subtasks: true, has_hidden_subtasks: true },
        subtasks: { rows: [late], complete: true },
      }),
    )
    expect(delayChip()?.dataset.delayChip).toBe('late')
  })

  it("follows the Board card's span of a group whose subtask has subtasks, as a subtask under it moves", async () => {
    await load()
    // the Board reads the far group, whose span the server works out from
    // the subtasks under its subtasks
    P.watchBoard('board:desktop', '{"board":1}')
    const { description: _text, ...fields } = far()
    const card = (end: string) => ({
      state: 'ok',
      rows: [
        {
          ...fields,
          has_subtasks: true,
          group_done: false,
          span: { start_week: day(0), end_week: end, partial: false },
        },
      ],
      parents: [],
      held_projects: ['work'],
    })
    await answer('tasks:board', card(day(7)))
    await openWindow(await noteTask(far()))
    // the window reads the group, whose one subtask has subtasks of its own
    const kid = short(task(FAR_KID, 42, { parent_id: FAR }), true)
    await answer(
      'taskWindow:task',
      okAnswer(far(), {
        task: { ...far(), has_subtasks: true },
        subtasks: { rows: [kid], complete: true },
      }),
    )
    expect(dialog()?.dataset.taskSource).toBe('answer')
    // the span ends before the due date, on track as the card is
    const verdict = () => P.delayOf(P.viewTask('board:desktop', FAR) ?? '')?.status
    expect(verdict()).toBe('ok')
    expect(delayChip()).toBeNull()
    // a subtask under its subtask now ends after the due date, which only
    // the Board's answer says, and the window follows the card
    await answer('tasks:board', card(day(28)))
    expect(verdict()).toBe('late')
    expect(delayChip()?.dataset.delayChip).toBe('late')
    // the Board hides and stops reading, so its kept card lends nothing
    await act(async () => P.watchBoard('board:desktop', null))
    expect(delayChip()?.dataset.delayChip).toBe('unknown')
  })

  it('says Delayed for a passed due date, as for a task the workspace holds, and nothing for a Done task or one without a due date or plan', async () => {
    await load()
    const handle = await noteTask(far())
    await openWindow(handle)
    await answer('taskWindow:task', okAnswer(far({ due_date: day(-2) })))
    expect(delayChip()?.dataset.delayChip).toBe('late')
    expect(await hintOf(delayChip())).toBe('Delayed, the due date has passed')
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
    expect(await hintOf(document.querySelector('[data-plan-unknown]'))).toBe(
      'Dates come from subtasks, which an archived task does not show',
    )
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

describe('the task window in a session that never asked for every task', {
  timeout: 30_000,
}, () => {
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

  it('opens nothing for a handle it knows nothing of, and never says it loads', async () => {
    // the far tasks are on the server; no task window is subscribed
    await load(true)
    expect(P.taskLoad()).toEqual({ state: 'not_asked' })
    await openWindow('QN-99')
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    // no load is on its way that could bring it, so the window does not wait
    expect(document.querySelector('[data-task-loading], [data-task-gone]')).toBeNull()
    expect(dialog()?.getAttribute('aria-hidden')).toBe('true')
    expect(reads()).toEqual([])
  })

  it("opens the Parent, Subtasks and Linked tasks pickers of a task shown from its answer on the server's candidates, with no ask", async () => {
    await load(true)
    const held = holdRelations()
    const handle = await noteTask(far())
    await openWindow(handle)
    await answer('taskWindow:task', okAnswer(far()))
    expect(dialog()?.dataset.taskSource).toBe('answer')
    const org = snap.orgs[0].id
    const { __layerProbe } = await import('../store/planner')
    for (const [label, kind, picked] of [
      ['Add subtask', 'subtask', task(PICKED_2, 45, { title: 'Wire it' })],
      ['Link task', 'link', task(PICKED_3, 46, { title: 'Test the range' })],
      ['Set parent', 'parent', task(PICKED, 44, { title: 'Build the mast' })],
    ] as const) {
      await click(document.querySelector(`[aria-label="${label}"]`))
      await nextFrame()
      expect(held.at(-1)?.args).toEqual({ org_id: org, issue_id: FAR, kind })
      await held.at(-1)?.answer(pickerBatch([pickerRow(picked)]))
      expect(document.querySelector(`[data-picker-row="${picked.id}"]`)).not.toBeNull()
      // a parent picked from the answer goes out marked, with no ask
      if (kind === 'parent') {
        await click(document.querySelector(`[data-picker-row="${picked.id}"]`))
        expect(sentArgs('issues:update').at(-1)).toMatchObject({
          id: FAR,
          patch: { parent_id: PICKED },
        })
      }
    }
    expect(__layerProbe?.asks()).toEqual([])
    expect(P.taskLoad()).toEqual({ state: 'not_asked' })
  })
})

describe('the task window’s Assignee and Reviewer', { timeout: 30_000 }, () => {
  /** every pickers: read, oldest first */
  let asked: { name: string; args: Record<string, unknown> }[]
  /* Answers the people pickers through their stand-in, and the other
     one-shot reads with nothing. */
  async function pickersAnswer() {
    asked = []
    const { isOwnerPickerRead, ownerPickersStandIn } = await import(
      '../store/ownerPickersStandIn.setup'
    )
    network.query.mockImplementation(async (ref, args) => {
      const name = getFunctionName(ref)
      if (!isOwnerPickerRead(name)) return null
      asked.push({ name, args })
      return structuredClone(ownerPickersStandIn(snap, name, args))
    })
  }
  const settle = async () => {
    for (let i = 0; i < 3; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
  }
  /* Opens the window on `handle` and waits the frame in which it takes
     focus, as a person does before a press. */
  const openSettled = async (handle: string) => {
    await openWindow(handle)
    await act(async () => await new Promise((r) => setTimeout(r, 50)))
  }
  const fieldName = (label: string) =>
    field(label)?.querySelector('[data-owner-name]')?.textContent ?? null
  const byIds = () => subs.filter((s) => s.name === 'people:byIds' && !s.closed)
  /* Gina is a person of the organization the workspace does not hold. */
  const GINA = {
    id: 'gina',
    name: 'Gina Ghost',
    org_role: 'user',
    kind: 'person',
    active: true,
    pending: false,
    color: '#335577',
    initials: 'GG',
  }

  it('opens the shared owner list in a popover, keeping the field’s hooks, and writes a pick', async () => {
    await load(false, (next) => {
      const fam = next.issues.find((t) => t.id === FAM)
      if (fam) fam.assignee_id = 'leo'
    })
    await pickersAnswer()
    await openSettled(P.handleOf(FAM) ?? '')
    expect(field('Assignee')?.disabled).toBe(false)
    expect(fieldName('Assignee')).toBe('Leo Park')
    expect(fieldName('Reviewer')).toBe('No reviewer')
    // a screen reader hears the field and its holder, as the menu said
    expect(field('Assignee')?.getAttribute('aria-label')).toBe('Assignee, Leo Park')
    expect(field('Reviewer')?.getAttribute('aria-label')).toBe('Reviewer, No reviewer')
    // nothing is read before a list opens, and no name by id
    expect(asked).toEqual([])
    expect(byIds()).toEqual([])
    await click(field('Assignee'))
    await settle()
    expect(document.querySelector('[data-owner-list="assignee"]')).not.toBeNull()
    expect(asked.find((a) => a.name === 'pickers:taskOwners')?.args).toEqual({
      org_id: snap.orgs[0].id,
      issue_id: FAM,
      field: 'assignee',
    })
    expect(document.querySelector('[data-owner-holder]')?.textContent).toContain('Leo Park')
    await click(document.querySelector('[data-owner-choice="mira"]'))
    expect(sentArgs('issues:update').at(-1)).toMatchObject({
      id: FAM,
      patch: { assignee_id: 'mira' },
    })
  })

  it('shows a reader without Edit the holder’s name, read-only, with nothing read', async () => {
    await load(false, (next) => {
      next.issues.push(
        task('01000000-0000-4000-8000-000000000031', 31, {
          project_id: 'manuals',
          assignee_id: 'leo',
          status: 'progress',
        }),
      )
    })
    await pickersAnswer()
    await openWindow(P.handleOf('01000000-0000-4000-8000-000000000031') ?? '')
    expect(field('Assignee')?.disabled).toBe(true)
    expect(await hintOf(field('Assignee'))).toBe(READ_ONLY)
    expect(fieldName('Assignee')).toBe('Leo Park')
    await click(field('Assignee'))
    await settle()
    expect(asked).toEqual([])
    expect(byIds()).toEqual([])
  })

  it('names a holder the workspace does not hold by id, loading until the answer', async () => {
    await load(false, (next) => {
      const fam = next.issues.find((t) => t.id === FAM)
      if (fam) fam.assignee_id = 'gina'
    })
    await pickersAnswer()
    await openSettled(P.handleOf(FAM) ?? '')
    expect(fieldName('Assignee')).toBe('Loading…')
    expect(field('Assignee')?.getAttribute('aria-label')).toBe('Assignee, Loading…')
    expect(byIds().map((s) => s.args)).toEqual([{ org_id: snap.orgs[0].id, ids: ['gina'] }])
    await act(async () => byIds()[0].deliver({ rows: [GINA] }))
    expect(fieldName('Assignee')).toBe('Gina Ghost')
    expect(field('Assignee')?.getAttribute('aria-label')).toBe('Assignee, Gina Ghost')
  })

  it('says Unassigned for a holder only on an answer that leaves them out, and a failed name as failed', async () => {
    await load(false, (next) => {
      const fam = next.issues.find((t) => t.id === FAM)
      if (fam) fam.assignee_id = 'gone-person'
    })
    await pickersAnswer()
    await openSettled(P.handleOf(FAM) ?? '')
    expect(fieldName('Assignee')).toBe('Loading…')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => byIds()[0].fail(new Error('Server Error')))
    expect(fieldName('Assignee')).toBe("Couldn't load this person")
    // the list still opens
    await click(field('Assignee'))
    await settle()
    expect(document.querySelector('[data-owner-list="assignee"]')).not.toBeNull()
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    // a fresh window's answer that leaves the id out
    await load(false, (next) => {
      const fam = next.issues.find((t) => t.id === FAM)
      if (fam) fam.assignee_id = 'gone-person'
    })
    await openSettled(P.handleOf(FAM) ?? '')
    await act(async () => byIds()[0].deliver({ rows: [] }))
    expect(fieldName('Assignee')).toBe('Unassigned')
  })

  it('names the Inbox pane’s owner the same way', async () => {
    await load(false, (next) => {
      const fam = next.issues.find((t) => t.id === FAM)
      if (fam) fam.assignee_id = 'gina'
    })
    const { IssueDetail } = await import('./IssueDetail')
    await act(async () =>
      root.render(
        <TooltipProvider>
          <IssueDetail issueId={P.handleOf(FAM) ?? ''} onClose={onClose} onOpen={onOpen} embedded />
        </TooltipProvider>,
      ),
    )
    const owner = () => document.querySelector('[data-task-assignee-name]')?.textContent
    expect(owner()).toBe('Loading…')
    await act(async () => byIds()[0].deliver({ rows: [GINA] }))
    expect(owner()).toBe('Gina Ghost')
  })

  it('writes a pick on a task shown from its answer through that answer', async () => {
    await load()
    await pickersAnswer()
    await openWindow(await noteTask(far()))
    await answer('taskWindow:task', okAnswer(far()))
    expect(dialog()?.dataset.taskSource).toBe('answer')
    await click(field('Assignee'))
    await settle()
    await click(document.querySelector('[data-owner-choice="leo"]'))
    expect(sentArgs('issues:update').at(-1)).toMatchObject({
      org_id: snap.orgs[0].id,
      id: FAR,
      patch: { assignee_id: 'leo' },
    })
    expect(sentArgs('issues:update').at(-1)).toHaveProperty('expected')
  })

  it('closes an open list as the field turns off, and its rows then write nothing', async () => {
    await load()
    await pickersAnswer()
    await openWindow(await noteTask(far()))
    await answer('taskWindow:task', okAnswer(far()))
    await answer('snapshot:threadComments', { comments: [], earlier: false })
    await click(field('Assignee'))
    await settle()
    const leo = document.querySelector<HTMLElement>('[data-owner-choice="leo"]')
    expect(leo).not.toBeNull()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => one('taskWindow:task').fail(new Error('Server Error')))
    await settle()
    expect(field('Assignee')?.disabled).toBe(true)
    expect(document.querySelector('[data-owner-list]')).toBeNull()
    const sent = sentArgs('issues:update').length
    await click(leo)
    expect(sentArgs('issues:update')).toHaveLength(sent)
  })
})
