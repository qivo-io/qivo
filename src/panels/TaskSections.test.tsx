// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act, Profiler, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { LIMITS } from '../../convex/lib/limits'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The task window's Subtasks, Linked tasks and Attachments on the real
   store, each from its own answer (convex/taskWindow.ts task, links and
   attachments), answered by hand. Mira leads Work, where the family task
   "Calibrate the sensor" (QN-27) lives with its subtasks, and only views
   Manuals, where one subtask waits for Leo's review. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | {
    holdWindow(from: string | null): void
    failWindow(from: string | null): void
  },
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
const SECTIONS = ['taskWindow:task', 'taskWindow:links', 'taskWindow:attachments']

let P: Planner
let container: HTMLDivElement
let root: Root
let snap: Snapshot
let subs: Live[]
let opened: Mock<(id: string) => void>
/* Delivers the workspace again, as after a write the server stored. */
let publish: () => void

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
/* Task `row` as the short row an answer sends (convex/lib/taskWindow.ts
   ShortRow). */
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
const row = (id: string) => {
  const found = snap.issues.find((t) => t.id === id)
  if (!found) throw new Error(`missing ${id}`)
  return found
}
const taskAnswer = (kids: unknown[], complete = true, hidden = false, id = 'fam') => ({
  state: 'ok',
  task: { ...row(id), has_subtasks: kids.length > 0, has_hidden_subtasks: hidden || !complete },
  level: 'lead',
  labels: [],
  follow: null,
  parent: null,
  subtasks: { rows: kids, complete },
})
const link = (id: string, source: string, target: string, type = 'blocks') => ({
  id,
  source_id: source,
  target_id: target,
  type,
  created_at: AT,
})
const linksAnswer = (links: unknown[], tasks: unknown[], complete = true) => ({
  state: 'ok',
  links,
  tasks,
  complete,
})
const file = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  issue_id: 'fam',
  name: `${id}.pdf`,
  size_bytes: 2048,
  mime: 'application/pdf',
  storage_id: `storage-${id}`,
  uploaded_by: 'mira',
  created_at: AT,
  ...extra,
})
const filesAnswer = (rows: unknown[], complete = true) => ({
  state: 'ok',
  rows,
  count: rows.length,
  complete,
})

/* Mira, Leo, Work under Plan (Mira leads it), Manuals under Docs (Mira
   views it), and the family task with its subtasks, a link and two files,
   one of them an image in its description. */
function fixture() {
  const next = plannerFixture()
  snap = next
  const me = next.profiles[0]
  Object.assign(me, { id: 'mira', name: 'Mira Holm', org_role: 'user' })
  next.myProfileIds = ['mira']
  next.profiles.push({ ...me, id: 'leo', name: 'Leo Park', auth_user_id: 'account-leo' })
  const base = next.projects[0]
  next.projects = [
    { ...base, id: 'plan', type: 'meta', key: 'PLAN', name: 'Plan', lead_id: 'mira' },
    { ...base, id: 'work', type: 'project', key: 'WORK', num: 2, name: 'Work', parent_id: 'plan' },
    // somewhere to move a task to
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
  next.orgs[0].next_issue_num = 40
  next.issues.push(
    task('fam', 27, { title: 'Calibrate the sensor', status: 'progress' }),
    task('kid-1', 28, { title: 'Mount the board', parent_id: 'fam', remaining_hours: 3 }),
    task('kid-2', 29, {
      title: 'Order parts',
      parent_id: 'fam',
      status: 'done',
      remaining_hours: 2,
    }),
    task('kid-ro', 30, {
      title: 'Read the manual',
      parent_id: 'fam',
      project_id: 'manuals',
      status: 'review',
      assignee_id: 'mira',
      reviewer_id: 'leo',
      remaining_hours: 1.5,
    }),
    task('other', 31, { title: 'Ship firmware', assignee_id: 'leo' }),
    task('manual', 32, { title: 'Write the manual', project_id: 'manuals' }),
  )
  next.links.push(link('link-1', 'fam', 'other') as Snapshot['links'][number])
  next.attachments.push(
    file('file-1') as Snapshot['attachments'][number],
    file('image-1', { name: 'photo.webp', inline: true }) as Snapshot['attachments'][number],
  )
  return next
}

/* Loads the store over `next`, with a message about the family task in
   Mira's Inbox. `beforeBoot` runs once the store's modules are in place. */
async function load(next = fixture(), beforeBoot?: () => Promise<void>) {
  vi.resetModules()
  snap = next
  snap.messages.push({
    id: 'message-1',
    org_id: snap.orgs[0].id,
    recipient_id: 'mira',
    issue_id: 'fam',
    issue_title: 'Calibrate the sensor',
    kind: 'comment',
    detail: 'New comment',
    created_at: AT,
  })
  subs = []
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      publish = () => next(structuredClone(snap))
      publish()
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
  await beforeBoot?.()
  await store.initStore()
}

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // a picker follows its own size
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  window.showToast = vi.fn()
  opened = vi.fn<(id: string) => void>()
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
function one(name: string): Live {
  const live = open(name)
  expect(live).toHaveLength(1)
  return live[0]
}
const answer = (name: string, value: unknown) => act(async () => one(name).deliver(value))
/* The writes of mutation `name` the store sent, their arguments in order. */
const sentArgs = (name: string) =>
  network.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === name)
    .map(([, args]) => args as Record<string, unknown>)
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
const pickerRow = (task: Task) => {
  const { has_subtasks: _group, ...rest } = short(task)
  return rest
}
const pickerBatch = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
  state: 'ok',
  rows,
  next: null,
  all_projects: null,
  stopped: false,
  blocked: null,
  ...extra,
})
const fail = (name: string) => act(async () => one(name).fail(new Error('Server Error')))
/* Delivers what the server holds of the family task to the three lists. */
const answerAll = async () => {
  await answer(
    'taskWindow:task',
    taskAnswer([short(row('kid-1')), short(row('kid-2')), short(row('kid-ro'))]),
  )
  await answer(
    'taskWindow:links',
    linksAnswer([link('link-1', 'fam', 'other')], [short(row('other'))]),
  )
  await answer(
    'taskWindow:attachments',
    filesAnswer([file('file-1'), file('image-1', { name: 'photo.webp', inline: true })]),
  )
}

async function openTask(uuid = 'fam') {
  const handle = P.handleOf(uuid)
  if (!handle) throw new Error(`missing ${uuid}`)
  await openHandle(handle)
}

/* Opens the window on `handle`, a handle or a reference
   (lib/taskReference.ts). */
async function openHandle(handle: string) {
  const { IssueDetail } = await import('./IssueDetail')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <IssueDetail issueId={handle} onClose={vi.fn()} onOpen={opened} />
      </TooltipProvider>,
    ),
  )
}

const section = (name: string, scope: ParentNode = document) => {
  const found = scope.querySelector<HTMLElement>(`[data-section="${name}"]`)
  if (!found) throw new Error(`missing the ${name} section`)
  return found
}
const stateOf = (name: string) => section(name).dataset.sectionState
const headingOf = (name: string) => section(name).querySelector('.task-section-head')?.textContent
const noteOf = (name: string) =>
  section(name).querySelector('[data-section-note], [data-section-failure]')?.textContent ?? null
const titlesOf = (name: string) =>
  [...section(name).querySelectorAll('[data-related-task]')].map(
    (r) => r.querySelector('.line-clamp-2')?.textContent,
  )
const progress = () => {
  const block = document.querySelector('[data-progress]')
  return block ? [...block.querySelectorAll('span.text-xs')].map((s) => s.textContent) : null
}
/* The tooltip of `element`, which a Button draws from its title, as a
   pointer over it opens it; a disabled control takes no focus. */
async function hintOf(element: Element | null | undefined) {
  const trigger = element?.closest<HTMLElement>('[data-tooltip-trigger]')
  if (!trigger) return null
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
const rollup = () => {
  const el = document.querySelector<HTMLElement>('[data-remaining-rollup]')
  return el ? [el.dataset.remainingRollup, el.textContent] : null
}

describe("the task window's sections", { timeout: 20_000 }, () => {
  /* What the window shows of each list: its heading, its rows and its line. */
  const shown = () =>
    ['subtasks', 'links', 'attachments'].map((name) => ({
      head: headingOf(name),
      rows: section(name).querySelector('.task-section-head')?.nextElementSibling?.outerHTML,
    }))

  it("lists a complete workspace's rows at once, and the answers take over unseen", async () => {
    await load()
    await openTask()
    for (const name of SECTIONS) expect(open(name)).toHaveLength(1)
    for (const name of ['subtasks', 'links', 'attachments']) {
      expect(stateOf(name)).toBe('complete')
      expect(section(name).dataset.sectionSource).toBe('workspace')
    }
    expect(headingOf('subtasks')).toBe('Subtasks (3)')
    expect(titlesOf('subtasks')).toEqual(['Mount the board', 'Order parts', 'Read the manual'])
    expect(headingOf('links')).toBe('Linked tasks (1)')
    expect(headingOf('attachments')).toBe('Attachments (1)')
    expect(document.body.textContent).not.toContain('Loading subtasks…')
    // Progress and Remaining by the workspace's rules, as before the sections
    expect(progress()).toEqual(['1 of 3 tasks done, 33%'])
    expect(rollup()).toEqual(['complete', 'Σ 4.5h'])
    const before = shown()
    await answerAll()
    for (const name of ['subtasks', 'links', 'attachments'])
      expect(section(name).dataset.sectionSource).toBe('answer')
    // the answers agree, so nothing on screen moved
    expect(shown()).toEqual(before)
    expect(progress()).toEqual(['1 of 3 tasks done, 33%'])
    expect(rollup()).toEqual(['complete', 'Σ 4.5h'])
  })

  it("keeps a complete workspace's lists while no answer comes, as when offline", async () => {
    await load()
    await openTask()
    // the connection is down: the subscriptions wait and nothing answers
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(titlesOf('subtasks')).toEqual(['Mount the board', 'Order parts', 'Read the manual'])
    expect(titlesOf('links')).toEqual(['Ship firmware'])
    expect(
      [...section('attachments').querySelectorAll('[data-attachment-open]')].map(
        (b) => (b as HTMLElement).dataset.attachmentOpen,
      ),
    ).toEqual(['file-1.pdf'])
    for (const name of ['subtasks', 'links', 'attachments']) expect(noteOf(name)).toBeNull()
    // a removal works from the workspace's rows, as before the sections
    const remove = section('subtasks').querySelector<HTMLButtonElement>(
      '[data-related-task="QN-28"] .task-related-remove',
    )
    expect(remove?.disabled).toBe(false)
  })

  it('shows each whole list with its count, and the totals from it', async () => {
    await load()
    await openTask()
    await answerAll()
    expect(stateOf('subtasks')).toBe('complete')
    expect(headingOf('subtasks')).toBe('Subtasks (3)')
    expect(titlesOf('subtasks')).toEqual(['Mount the board', 'Order parts', 'Read the manual'])
    expect(noteOf('subtasks')).toBeNull()
    expect(progress()).toEqual(['1 of 3 tasks done, 33%'])
    // the open hours of the unfinished leaves: 3 + 1.5
    expect(rollup()).toEqual(['complete', 'Σ 4.5h'])
    expect(headingOf('links')).toBe('Linked tasks (1)')
    expect(titlesOf('links')).toEqual(['Ship firmware'])
    // the image in the description is no row of the section
    expect(headingOf('attachments')).toBe('Attachments (1)')
    expect(
      [...section('attachments').querySelectorAll('[data-attachment-open]')].map(
        (b) => (b as HTMLElement).dataset.attachmentOpen,
      ),
    ).toEqual(['file-1.pdf'])
  })

  it('says a cut list is incomplete, with no count and unknown totals', async () => {
    await load()
    await openTask()
    await answer('taskWindow:task', taskAnswer([short(row('kid-1'))], false))
    expect(stateOf('subtasks')).toBe('incomplete')
    expect(headingOf('subtasks')).toBe('Subtasks')
    expect(titlesOf('subtasks')).toEqual(['Mount the board'])
    expect(noteOf('subtasks')).toBe('Some subtasks could not be loaded.')
    expect(progress()).toEqual(['Completion unknown.', 'Not every subtask could be loaded.'])
    expect(rollup()).toEqual(['unknown', 'Unknown'])
    await answer('taskWindow:links', linksAnswer([], [], false))
    expect(noteOf('links')).toBe('Some linked tasks could not be loaded.')
    await answer('taskWindow:attachments', filesAnswer([file('file-1')], false))
    expect(headingOf('attachments')).toBe('Attachments')
    expect(noteOf('attachments')).toBe('Some attachments could not be loaded.')
  })

  it('says a list is not available when the server no longer lists the task', async () => {
    await load()
    await openTask()
    await answer('taskWindow:task', { state: 'unavailable' })
    await answer('taskWindow:links', { state: 'unavailable' })
    await answer('taskWindow:attachments', { state: 'unavailable' })
    expect(stateOf('subtasks')).toBe('unavailable')
    expect(noteOf('subtasks')).toBe('Subtasks are not available.')
    expect(titlesOf('subtasks')).toEqual([])
    expect(noteOf('links')).toBe('Linked tasks are not available.')
    expect(noteOf('attachments')).toBe('Attachments are not available.')
    expect(progress()).toEqual(['Completion unknown.'])
    expect(rollup()).toEqual(['unknown', 'Unknown'])
  })

  it('says a whole empty list is empty', async () => {
    await load()
    await openTask()
    await answer('taskWindow:task', taskAnswer([]))
    await answer('taskWindow:links', linksAnswer([], []))
    await answer('taskWindow:attachments', filesAnswer([]))
    expect(noteOf('subtasks')).toBe('No subtasks.')
    expect(headingOf('subtasks')).toBe('Subtasks')
    expect(noteOf('links')).toBe('No dependencies yet.')
    // an editor keeps the drop zone in place of the sentence
    expect(noteOf('attachments')).toBeNull()
    expect(section('attachments').textContent).toContain('Drop files here')
  })

  it('says No attachments. only to a person who cannot add files', async () => {
    await load()
    await openTask('manual')
    await act(async () => one('taskWindow:attachments').deliver(filesAnswer([])))
    expect(noteOf('attachments')).toBe('No attachments.')
    expect(section('attachments').textContent).not.toContain('Drop files here')
  })

  it('shows a failed list with Retry, keeps the rows read before, and loads it again', async () => {
    await load()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await openTask()
    await fail('taskWindow:task')
    // a complete workspace's rows stay, and the read that failed says so
    expect(stateOf('subtasks')).toBe('failed')
    expect(titlesOf('subtasks')).toEqual(['Mount the board', 'Order parts', 'Read the manual'])
    expect(noteOf('subtasks')).toBe("Couldn't load the latest subtasks.Retry")
    expect(progress()).toEqual(['1 of 3 tasks done, 33%'])
    // the thread's failure rows are its own
    expect(document.querySelectorAll('[data-thread-failure]')).toHaveLength(0)
    const retry = section('subtasks').querySelector<HTMLElement>('[data-section-failure] button')
    await act(async () => retry?.click())
    expect(stateOf('subtasks')).toBe('retrying')
    expect(noteOf('subtasks')).toBe('Loading the latest subtasks…')
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    await answer('taskWindow:task', taskAnswer([short(row('kid-1'))]))
    expect(titlesOf('subtasks')).toEqual(['Mount the board'])
    // a failure after the list arrived keeps its rows, and says the newest failed
    await fail('taskWindow:task')
    expect(titlesOf('subtasks')).toEqual(['Mount the board'])
    expect(headingOf('subtasks')).toBe('Subtasks')
    expect(noteOf('subtasks')).toBe("Couldn't load the latest subtasks.Retry")
    expect(progress()).toEqual(['Completion unknown.', 'Not every subtask could be loaded.'])
    // the workspace's lists stay beside the other failures
    await fail('taskWindow:links')
    expect(noteOf('links')).toBe("Couldn't load the latest linked tasks.Retry")
    await fail('taskWindow:attachments')
    expect(noteOf('attachments')).toBe("Couldn't load the latest attachments.Retry")
  })

  it('reads a short row from the answer for a task the workspace does not hold', async () => {
    await load()
    await openTask()
    const elsewhere = short(
      task('far', 39, { title: 'Tune the filter', status: 'progress', assignee_id: 'leo' }),
    )
    await answer('taskWindow:task', taskAnswer([short(row('kid-1')), elsewhere]))
    const far = section('subtasks').querySelector('[data-related-task="QN-39"]')
    if (!far) throw new Error('missing the short row')
    expect(far.textContent).toContain('Tune the filter')
    expect(far.textContent).toContain('Work')
    expect(far.querySelector('[role="img"][aria-label="In Progress"]')).not.toBeNull()
    expect(far.querySelector('[data-avatar="leo"]')).not.toBeNull()
    // opening it passes a reference with its organization, number and
    // uuid, which the window reads from the server
    await act(async () => far.querySelector<HTMLElement>('button')?.click())
    const { refParts } = await import('../lib/taskReference')
    expect(refParts(opened.mock.calls.at(-1)?.[0])).toEqual({
      org: snap.orgs[0].id,
      num: 39,
      uuid: 'far',
    })
    // its × works from the short row, with this task as the parent it
    // shows, and the row leaves the list at once
    const remove = far.querySelector<HTMLButtonElement>('.task-related-remove')
    expect(remove?.disabled).toBe(false)
    network.mutation.mockImplementation(() => new Promise(() => {}))
    await act(async () => remove?.click())
    expect(sentArgs('issues:update').at(-1)).toEqual({
      org_id: snap.orgs[0].id,
      id: 'far',
      patch: { parent_id: null },
      expected: { parent_id: 'fam', has_hidden_parent: false },
    })
    expect(section('subtasks').querySelector('[data-related-task="QN-39"]')).toBeNull()
  })

  it('draws a short group without a status, and a short task in review with its reviewer', async () => {
    await load()
    await openTask()
    const group = short(task('far-group', 38, { title: 'Old epic' }), true)
    const review = short(
      task('far-review', 39, {
        title: 'Check the wiring',
        status: 'review',
        assignee_id: 'mira',
        reviewer_id: 'leo',
      }),
    )
    await answer('taskWindow:task', taskAnswer([group, review]))
    const groupRow = section('subtasks').querySelector('[data-related-task="QN-38"]')
    expect(groupRow?.querySelector('[role="img"][aria-label]:not([data-avatar])')).toBeNull()
    const reviewRow = section('subtasks').querySelector('[data-related-task="QN-39"]')
    expect(reviewRow?.querySelector('[data-avatar="leo"]')).not.toBeNull()
    expect(reviewRow?.querySelector('[data-avatar="mira"]')).toBeNull()
    // a group row leaves the open hours unknown
    expect(rollup()).toEqual(['unknown', 'Unknown'])
    expect(progress()).toEqual([
      '0 of 1 visible tasks done. Completion unknown.',
      'Additional work is outside this view.',
    ])
  })

  it("shows the person's own edit of a held subtask at once", async () => {
    await load()
    network.mutation.mockImplementation(() => new Promise(() => {}))
    await openTask()
    await answerAll()
    await act(async () => {
      P.updateIssue(P.handleOf('kid-1') ?? '', { title: 'Mount the new board' })
    })
    expect(titlesOf('subtasks')).toEqual(['Mount the new board', 'Order parts', 'Read the manual'])
  })

  it('removes a link only the links answer holds, between held tasks, with the kind it shows', async () => {
    await load()
    await openTask()
    // a link to a held task that no workspace delivery holds yet
    await answer(
      'taskWindow:links',
      linksAnswer(
        [link('link-1', 'fam', 'other'), { ...link('link-9', 'fam', 'manual'), created_at: AT }],
        [short(row('other')), short(row('manual'))],
      ),
    )
    const removeOf = (handle: string) =>
      section('links').querySelector<HTMLButtonElement>(
        `[data-related-task="${handle}"] .task-related-remove`,
      )
    expect(removeOf('QN-32')?.disabled).toBe(false)
    expect(removeOf('QN-31')?.disabled).toBe(false)
    network.mutation.mockImplementation(() => new Promise(() => {}))
    await act(async () => removeOf('QN-32')?.click())
    expect(sentArgs('issues:removeLink').at(-1)).toEqual({
      org_id: snap.orgs[0].id,
      a: 'fam',
      b: 'manual',
      expected: { kind: 'blocks' },
    })
    // busy until its answer, so a second press sends nothing
    expect(removeOf('QN-32')?.dataset.removeBusy).toBe('')
    await act(async () => removeOf('QN-32')?.click())
    expect(sentArgs('issues:removeLink')).toHaveLength(1)
  })

  it('keeps a link’s × waiting while the links list failed, as its kind comes from that list', async () => {
    await load()
    const reads = holdRelations()
    await openTask()
    await answerAll()
    const remove = () =>
      section('links').querySelector<HTMLButtonElement>(
        '[data-related-task="QN-31"] .task-related-remove',
      )
    expect(remove()?.disabled).toBe(false)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await fail('taskWindow:links')
    expect(remove()?.disabled).toBe(true)
    expect(await hintOf(remove())).toBe('Available once Qivo can check this task for changes')
    // the picker keeps the link it delivered, checked, without a press
    await act(async () =>
      document.querySelector<HTMLElement>('button[aria-label="Link task"]')?.click(),
    )
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
    await reads.at(-1)?.answer(pickerBatch([]))
    const kept = document.querySelector<HTMLButtonElement>('[data-picker-row="other"]')
    expect(kept?.dataset.pickerCurrent).toBe('')
    expect(kept?.getAttribute('aria-pressed')).toBe('true')
    expect(kept?.disabled).toBe(true)
    expect(document.querySelector('[data-relation-picker]')?.textContent).toContain(
      'Some current linked tasks could not be loaded.',
    )
  })

  it('keeps a subtask’s × waiting while the Subtasks list failed, as its expected parent comes from that list', async () => {
    await load()
    await openTask()
    await answerAll()
    const remove = () =>
      section('subtasks').querySelector<HTMLButtonElement>(
        '[data-related-task="QN-28"] .task-related-remove',
      )
    expect(remove()?.disabled).toBe(false)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await fail('taskWindow:task')
    expect(remove()?.disabled).toBe(true)
    expect(await hintOf(remove())).toBe('Available once Qivo can check this task for changes')
  })

  it('makes a subtask the picker took off a subtask again, from the row the window showed', async () => {
    await load()
    const reads = holdRelations()
    await openTask()
    const far = short(task('far', 39, { title: 'Tune the filter', parent_id: 'fam' }))
    await answer('taskWindow:task', taskAnswer([far]))
    await act(async () =>
      document.querySelector<HTMLElement>('button[aria-label="Add subtask"]')?.click(),
    )
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
    await reads.at(-1)?.answer(pickerBatch([]))
    const rowOf = () => document.querySelector<HTMLButtonElement>('[data-picker-row="far"]')
    expect(rowOf()?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => rowOf()?.click())
    expect(sentArgs('issues:update').at(-1)).toMatchObject({
      id: 'far',
      patch: { parent_id: null },
      expected: { parent_id: 'fam', has_hidden_parent: false },
    })
    // the window's list drops it at once, and the picker keeps it, unchecked
    expect(titlesOf('subtasks')).toEqual([])
    expect(rowOf()?.getAttribute('aria-pressed')).toBe('false')
    await act(async () => rowOf()?.click())
    expect(sentArgs('issues:update').at(-1)).toMatchObject({
      id: 'far',
      patch: { parent_id: 'fam' },
      expected: { parent_id: null, has_hidden_parent: false },
    })
    expect(titlesOf('subtasks')).toEqual(['Tune the filter'])
    expect(rowOf()?.getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps Read-only project access on a held row the person cannot edit', async () => {
    await load()
    await openTask()
    await answerAll()
    const readOnly = section('subtasks').querySelector('[data-related-task="QN-30"]')
    const remove = readOnly?.querySelector<HTMLButtonElement>('.task-related-remove')
    expect(remove?.disabled).toBe(true)
    expect(await hintOf(remove)).toBe('Read-only project access')
    const held = section('subtasks').querySelector('[data-related-task="QN-28"]')
    expect(held?.querySelector<HTMLButtonElement>('.task-related-remove')?.disabled).toBe(false)
  })

  it('takes a subtask off only where its short row and the workspace both say Edit', async () => {
    await load()
    await openTask()
    // rows the workspace does not hold, whose answer's level and the
    // workspace's level disagree either way, beside one where both say Edit
    const editable = short(task('far', 39, { title: 'Tune the filter' }))
    const viewedHere = { ...short(task('far-2', 38, { title: 'Sand the case' })), level: 'viewer' }
    const viewedThere = {
      ...short(task('far-3', 37, { title: 'Proof the manual', project_id: 'manuals' })),
      level: 'lead',
    }
    await answer('taskWindow:task', taskAnswer([editable, viewedHere, viewedThere]))
    const removeOf = (handle: string) =>
      section('subtasks').querySelector<HTMLButtonElement>(
        `[data-related-task="${handle}"] .task-related-remove`,
      )
    expect(removeOf('QN-39')?.disabled).toBe(false)
    for (const handle of ['QN-38', 'QN-37']) {
      expect(removeOf(handle)?.disabled, handle).toBe(true)
      expect(await hintOf(removeOf(handle)), handle).toBe('Read-only project access')
    }
  })

  it('reads each link from the open task, and in the past tense for a Done task', async () => {
    const next = fixture()
    next.issues.push(
      task('blocker', 33, { title: 'Get approval' }),
      task('peer', 34, { title: 'Write the notes' }),
      task('done-blocker', 35, { title: 'Sign off', status: 'done' }),
    )
    await load(next)
    await openTask()
    const links = [
      link('link-1', 'fam', 'other'),
      { ...link('link-2', 'blocker', 'fam'), created_at: '2026-09-14T09:00:00.000Z' },
      { ...link('link-3', 'fam', 'peer', 'relates'), created_at: '2026-09-14T10:00:00.000Z' },
      { ...link('link-4', 'done-blocker', 'fam'), created_at: '2026-09-14T11:00:00.000Z' },
    ]
    await answer(
      'taskWindow:links',
      linksAnswer(
        links,
        ['other', 'blocker', 'peer', 'done-blocker'].map((id) => short(row(id))),
      ),
    )
    const relations = [...section('links').querySelectorAll('[data-related-task]')].map(
      (r) => r.querySelector('.text-xs.font-semibold')?.textContent,
    )
    expect(relations).toEqual(['Blocks', 'Blocked by', 'Relates to', 'Was blocked by'])
    expect(headingOf('links')).toBe('Linked tasks (4)')
  })

  it('opens and downloads a file only the answer holds', async () => {
    await load()
    await openTask()
    await answer('taskWindow:attachments', filesAnswer([file('file-1'), file('file-2')]))
    network.query.mockImplementation(async (ref, args: { attachment_ids?: string[] }) =>
      getFunctionName(ref) === 'files:mintUrls'
        ? {
            attachments: Object.fromEntries(
              (args.attachment_ids ?? []).map((id) => [
                id,
                { url: `https://files.test/files/${id}?t=1`, exp: Date.now() / 1000 + 600 },
              ]),
            ),
            avatars: {},
          }
        : null,
    )
    const clicks: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this.href)
    })
    const row2 = section('attachments')
      .querySelector('[data-attachment-open="file-2.pdf"]')
      ?.closest('div')
    await act(async () => row2?.querySelector<HTMLElement>('[data-attachment-open]')?.click())
    await act(async () => row2?.querySelector<HTMLElement>('[aria-label="Download"]')?.click())
    expect(clicks).toEqual([
      expect.stringContaining('/files/file-2'),
      expect.stringMatching(/\/files\/file-2.*&download=1$/),
    ])
    // removing it goes to the server with no paint: the row shows busy
    // until the attachments answer drops it, when the removal resolves
    const removals: { args: unknown; resolve: (value: unknown) => void }[] = []
    network.mutation.mockImplementation(
      (ref, args) =>
        new Promise((resolve) => {
          if (getFunctionName(ref) === 'files:removeAttachment') removals.push({ args, resolve })
          else resolve(null)
        }),
    )
    const remove = () =>
      section('attachments')
        .querySelector('[data-attachment-open="file-2.pdf"]')
        ?.closest('div')
        ?.querySelector<HTMLButtonElement>(
          '[aria-label="Remove attachment"], [aria-label="Confirm removal"]',
        )
    expect(remove()?.disabled).toBe(false)
    await act(async () => remove()?.click())
    // a second press confirms, once the first's ignore time has passed
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)))
    await act(async () => remove()?.click())
    expect(removals.map((r) => r.args)).toEqual([{ org_id: snap.orgs[0].id, id: 'file-2' }])
    expect(remove()?.disabled).toBe(true)
    expect(remove()?.dataset.attachmentRemoving).toBe('')
    await answer('taskWindow:attachments', filesAnswer([file('file-1')]))
    await act(async () => removals[0]?.resolve(null))
    expect(section('attachments').querySelector('[data-attachment-open="file-2.pdf"]')).toBeNull()
  })

  it("shows the totals beside hidden subtasks as the visible ones'", async () => {
    await load()
    await openTask()
    await answer(
      'taskWindow:task',
      taskAnswer([short(row('kid-1')), short(row('kid-2'))], true, true),
    )
    expect(progress()).toEqual([
      '1 of 2 visible tasks done. Completion unknown.',
      'Additional work is outside this view.',
    ])
    expect(rollup()).toEqual(['visible', 'Σ 3h'])
  })

  it('offers no new subtask in the picker once the server says the task is full, and keeps the current ones to take off', async () => {
    await load()
    const reads = holdRelations()
    await openTask()
    await answerAll()
    await act(async () =>
      document.querySelector<HTMLElement>('button[aria-label="Add subtask"]')?.click(),
    )
    // the picker opens a frame after the press
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
    const offered = () =>
      [...document.querySelectorAll<HTMLElement>('[data-picker-row]')].map(
        (b) => b.dataset.pickerRow,
      )
    // the window's current subtasks Mira can edit first, then the batch
    expect(reads.at(-1)?.args).toMatchObject({ issue_id: 'fam', kind: 'subtask' })
    await reads.at(-1)?.answer(pickerBatch([pickerRow(row('other'))]))
    expect(offered()).toEqual(['kid-1', 'kid-2', 'other'])
    // the server counts 100 active subtasks, hidden and archived ones
    // included, which the window does not list: no candidate, and the
    // window's sentence
    const search = document.querySelector<HTMLInputElement>('[data-relation-picker] input')
    await act(async () => {
      if (!search) return
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        search,
        'ship',
      )
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)))
    await reads.at(-1)?.answer(pickerBatch([], { blocked: 'full' }))
    expect(offered()).toEqual([])
    expect(
      document.querySelector<HTMLElement>('[data-relation-picker]')?.dataset.pickerBlocked,
    ).toBe('full')
    expect(document.querySelector('[data-relation-picker]')?.textContent).toContain(
      `This task has ${LIMITS.subtasks.max} active subtasks, the most a task can have.`,
    )
    expect(document.querySelector('[data-picker-create]')).toBeNull()
  })

  it("never shows a task's lists under the subtask opened from them", async () => {
    await load()
    const { IssueDetail } = await import('./IssueDetail')
    const frames: { subtasks: string; links: string; rollup: string | null }[] = []
    const record = () => {
      const subtasks = document.querySelector('[data-section="subtasks"]')?.textContent ?? ''
      const links = document.querySelector('[data-section="links"]')?.textContent ?? ''
      const roll = document.querySelector('[data-remaining-rollup]')?.textContent ?? null
      frames.push({ subtasks, links, rollup: roll })
    }
    const show = (uuid: string) =>
      act(async () =>
        root.render(
          <TooltipProvider>
            <Profiler id="window" onRender={record}>
              <IssueDetail issueId={P.handleOf(uuid)} onClose={vi.fn()} onOpen={opened} />
            </Profiler>
          </TooltipProvider>,
        ),
      )
    await show('fam')
    await answerAll()
    expect(titlesOf('subtasks')).toHaveLength(3)
    frames.length = 0
    // the floating window swaps its task in place
    await show('kid-1')
    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) {
      expect(frame.subtasks).not.toContain('Order parts')
      expect(frame.subtasks).not.toContain('Subtasks (')
      expect(frame.links).not.toContain('Ship firmware')
      expect(frame.rollup).toBeNull()
    }
    expect(one('taskWindow:task').args).toMatchObject({ ref: 'kid-1' })
  })
})

describe('which windows load the sections', { timeout: 20_000 }, () => {
  async function openInbox() {
    const { Inbox } = await import('./Inbox')
    const { usePlannerVersion } = await import('../store/usePlannerVersion')
    function InboxHost() {
      usePlannerVersion()
      const [openIssue, setOpenIssue] = useState<string | null>(null)
      return (
        <Inbox
          showOnBoard={vi.fn()}
          onExit={vi.fn()}
          openTask={setOpenIssue}
          openIssue={openIssue}
          onPlanOnRoadmap={vi.fn()}
        />
      )
    }
    await act(async () =>
      root.render(
        <TooltipProvider>
          <InboxHost />
        </TooltipProvider>,
      ),
    )
  }

  it('loads none for the desktop Inbox pane, once for its pop-out, and stops them as it closes', async () => {
    await load()
    await openInbox()
    const item = document.querySelector<HTMLElement>('[data-message="fam"] .inbox-message-open')
    await act(async () => item?.click())
    expect(one('snapshot:threadComments').args).toMatchObject({ issue_id: 'fam' })
    for (const name of SECTIONS) expect(subs.filter((s) => s.name === name)).toEqual([])
    const pane = document.querySelector('.inbox-detail-frame')
    await act(async () => pane?.querySelector<HTMLElement>('[data-task-popout]')?.click())
    for (const name of SECTIONS) expect(one(name).args).toMatchObject({ org_id: snap.orgs[0].id })
    const dialog = document.querySelector('[role="dialog"]:not(.inbox-detail-frame *)')
    await act(async () => dialog?.querySelector<HTMLElement>('[data-task-close]')?.click())
    expect(document.querySelector('[role="dialog"]:not(.inbox-detail-frame *)')).toBeNull()
    for (const name of SECTIONS) expect(open(name)).toEqual([])
    // the pane keeps its thread
    expect(one('snapshot:threadComments').args).toMatchObject({ issue_id: 'fam' })
  })

  it('loads them on a phone only while the Details tab shows', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('max-width'),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
    await load()
    await openTask()
    for (const name of SECTIONS) expect(open(name)).toEqual([])
    const tab = (label: string) =>
      [...document.querySelectorAll<HTMLElement>('[data-mobile-task-sections] button')].find(
        (b) => b.textContent === label,
      )
    await act(async () => tab('Details')?.click())
    for (const name of SECTIONS) expect(open(name)).toHaveLength(1)
    await act(async () => tab('Activity')?.click())
    for (const name of SECTIONS) expect(open(name)).toEqual([])
  })
})

describe('a new task before the server stored it', { timeout: 20_000 }, () => {
  afterEach(async () => {
    const { TASKS } = await import('../store/liveParts')
    TASKS.atBoot = true
    // no write went out on a path that needs every task, and no paint threw
    const { __layerProbe } = await import('../store/planner')
    expect(__layerProbe?.faults()).toEqual([])
  })

  /** Loads the store as the app boots it, without the workspace's tasks,
      and holds each create until the test accepts it with the number the
      server gave it. */
  async function loadNotAsked() {
    await load(fixture(), async () => {
      const { TASKS } = await import('../store/liveParts')
      TASKS.atBoot = false
    })
    const held: { name: string; args: Record<string, unknown>; resolve: (v: unknown) => void }[] =
      []
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (!name.startsWith('issues:create')) return Promise.resolve(null)
      return new Promise((resolve) => held.push({ name, args, resolve }))
    })
    return {
      /** Accepts the oldest create, answered as the server answers it. */
      accept: (num: number) =>
        act(async () => {
          const create = held.shift()
          if (!create) throw new Error('no create waits')
          // the stored row answers, for a linked task the new one's
          create.resolve(
            create.name === 'issues:createParent'
              ? { parent_num: num }
              : create.name === 'issues:createLinked'
                ? { id: create.args.new_id, title: create.args.title, num }
                : { ...create.args, num },
          )
          await new Promise((resolve) => setTimeout(resolve, 0))
        }),
    }
  }

  /* The reads of task `uuid` the store subscribed, by name. */
  const readsOf = (uuid: string) =>
    subs.filter((s) => JSON.stringify(s.args).includes(uuid)).map((s) => s.name)
  /* The new task's own answer, as the server sends it. */
  const ownAnswer = (uuid: string, num: number, title: string, kids: unknown[] = []) => ({
    state: 'ok',
    task: {
      ...task(uuid, num, { title, status: 'backlog', priority: 'low' }),
      has_subtasks: kids.length > 0,
    },
    level: 'lead',
    labels: [],
    follow: null,
    parent: null,
    subtasks: { rows: kids, complete: true },
  })
  const button = (label: string) =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  const menu = async () => {
    await act(async () => button('Task actions')?.click())
    const move = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Move to sub-project'),
    )
    return { move, fate: document.querySelector<HTMLButtonElement>('[data-task-fate]') }
  }

  it('shows the new task at once with its lists empty and whole, and keeps the controls that read the server waiting until its own read answered', async () => {
    const server = await loadNotAsked()
    let made: string | null = null
    await act(async () => {
      made = P.addIssue({ project: 'work', title: 'Order the spare sensors', assignee: 'mira' })
    })
    const { refParts } = await import('../lib/taskReference')
    const uuid = refParts(made)?.uuid ?? ''
    await openHandle(made ?? '')
    expect(document.querySelector('[data-task-title]')?.textContent).toContain(
      'Order the spare sensors',
    )
    for (const name of ['subtasks', 'links', 'attachments']) expect(stateOf(name)).toBe('complete')
    // the pickers that read the server about the task wait
    for (const label of ['Add subtask', 'Link task', 'Set parent']) {
      expect(button(label)?.disabled, label).toBe(true)
      expect(await hintOf(button(label)), label).toBe('Available once this task is saved')
    }
    for (const label of ['Assignee', 'Reviewer'])
      expect(document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.disabled).toBe(
        true,
      )
    const during = await menu()
    expect(during.move?.disabled).toBe(true)
    expect(during.fate?.disabled).toBe(true)
    expect(await hintOf(during.fate)).toBe('Available once this task is saved')
    // the eye follows at once, and its roster waits
    expect(button('Unsubscribe from task updates')?.disabled).toBe(false)
    // nothing that names the task reads the server before it exists
    expect(readsOf(uuid)).toEqual([])
    // the server took it: the window reads it, and its own answer ends the wait
    await server.accept(41)
    expect(
      readsOf(uuid)
        .filter((name) => SECTIONS.includes(name))
        .sort(),
    ).toEqual([...SECTIONS].sort())
    expect(button('Add subtask')?.disabled).toBe(true)
    await act(async () =>
      open('taskWindow:task')
        .find((s) => s.args.ref === uuid)
        ?.deliver(ownAnswer(uuid, 41, 'Order the spare sensors')),
    )
    const reads = holdRelations()
    for (const [label, kind] of [
      ['Add subtask', 'subtask'],
      ['Link task', 'link'],
      ['Set parent', 'parent'],
    ] as const) {
      expect(button(label)?.disabled, label).toBe(false)
      await act(async () => button(label)?.click())
      // the picker opens a frame after the press
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
      expect(reads.at(-1)?.args).toMatchObject({ issue_id: uuid, kind })
    }
  })

  for (const made of ['parent', 'linked task'] as const)
    it(`shows a new ${made} from its creating answer, and reads its thread and lists once the server took it`, async () => {
      const server = await loadNotAsked()
      // a task without subtasks, which the workspace does not hold, from
      // its answer
      const { taskRef } = await import('../lib/taskReference')
      await openHandle(taskRef({ org: snap.orgs[0].id, num: 31, uuid: 'other' }))
      await answer('taskWindow:task', taskAnswer([], true, false, 'other'))
      expect(P.handleOf('other')).toBeNull()
      await act(async () => {
        void (made === 'parent'
          ? P.createParent('QN-31', 'Build the rig')
          : P.createLinked('QN-31', 'blocks', 'Wire the rig'))
      })
      const sent =
        made === 'parent'
          ? sentArgs('issues:createParent').at(-1)?.parent_id
          : sentArgs('issues:createLinked').at(-1)?.new_id
      const uuid = typeof sent === 'string' ? sent : ''
      // the new task opens from its creating answer, reading nothing
      await openHandle(P.openTask(uuid, snap.orgs[0].id, 40))
      const title = made === 'parent' ? 'Build the rig' : 'Wire the rig'
      expect(P.taskDetail(uuid)).toMatchObject({ state: 'ok', saving: true })
      expect(readsOf(uuid)).toEqual([])
      expect(titlesOf('subtasks')).toEqual(made === 'parent' ? ['Ship firmware'] : [])
      // the new parent's subtask is removed from the parent's answer, so its
      // × waits as Subtasks + does
      if (made === 'parent') {
        expect(button('Remove subtask')?.disabled).toBe(true)
        expect(await hintOf(button('Remove subtask'))).toBe('Available once this task is saved')
      }
      // the server takes the create: its window reads its thread and its
      // own answer
      await server.accept(40)
      expect(open('snapshot:threadComments').filter((s) => s.args.issue_id === uuid)).toHaveLength(
        1,
      )
      const reads = open('taskWindow:task').filter((s) => s.args.ref === uuid)
      expect(reads).toHaveLength(1)
      const kids = made === 'parent' ? [short(row('other'))] : []
      await act(async () => reads[0].deliver(ownAnswer(uuid, 40, title, kids)))
      expect(P.taskDetail(uuid)).toMatchObject({ state: 'ok', saving: false })
      expect(titlesOf('subtasks')).toEqual(made === 'parent' ? ['Ship firmware'] : [])
      expect(stateOf('subtasks')).toBe('complete')
      // Move and Archive or delete wait only for this answer
      const view = P.taskDetail(uuid)?.view
      expect(view && P.familyOf(view)).not.toBeNull()
    })
})

describe("the task window's labels", { timeout: 20_000 }, () => {
  /* The family task with Hardware, which the workspace holds, and three
     labels it does not hold: two the server still has and one deleted. */
  function labelled() {
    const next = fixture()
    const org = next.orgs[0].id
    next.labels.push({
      id: 'label-hw',
      org_id: org,
      name: 'Hardware',
      name_lower: 'hardware',
      color: '#335577',
      created_at: AT,
    })
    for (const label_id of ['label-hw', 'label-far-b', 'label-far-a', 'label-gone'])
      next.issueLabels.push({ issue_id: 'fam', label_id })
    return next
  }
  const chips = () =>
    [...document.querySelectorAll<HTMLElement>('.task-label')].map((chip) => ({
      text: chip.querySelector('.task-label-name')?.textContent,
      waiting: chip.hasAttribute('data-label-waiting'),
      failed: chip.hasAttribute('data-label-failed'),
      remove: chip.querySelector('button')?.getAttribute('aria-label'),
      disabled: chip.querySelector('button')?.disabled,
    }))
  const removeOf = (name: string) =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="Remove label “${name}”"]`)
  const far = (id: string, name: string) => ({ id, name, color: '#4C9AFF' })

  it('shows a label the workspace does not hold as loading, then by name, and its × takes it off', async () => {
    await load(labelled())
    await openTask()
    const waiting = {
      text: 'Loading label…',
      waiting: true,
      failed: false,
      remove: 'Available once this label has loaded',
      disabled: true,
    }
    expect(chips()).toEqual([
      {
        text: 'Hardware',
        waiting: false,
        failed: false,
        remove: 'Remove label “Hardware”',
        disabled: false,
      },
      waiting,
      waiting,
      waiting,
    ])
    // one read of the ids the workspace does not hold, sorted
    expect(one('labels:byIds').args).toEqual({
      org_id: snap.orgs[0].id,
      ids: ['label-far-a', 'label-far-b', 'label-gone'],
    })
    await answer('labels:byIds', {
      rows: [far('label-far-a', 'Far A'), far('label-far-b', 'Far B')],
    })
    // the deleted one, which the answer leaves out, goes
    expect(chips().map((c) => c.text)).toEqual(['Hardware', 'Far A', 'Far B'])
    // the server stores the toggle, and its delivery holds it before the
    // write's answer, as Convex sends them
    network.mutation.mockImplementation(async (ref, args) => {
      if (getFunctionName(ref) === 'labels:toggle') {
        snap.issueLabels = snap.issueLabels.filter((il) => il.label_id !== args.label_id)
        publish()
      }
      return null
    })
    await act(async () => removeOf('Far A')?.click())
    expect(sentArgs('labels:toggle')).toEqual([
      { org_id: snap.orgs[0].id, issue_id: 'fam', label_id: 'label-far-a', on: false },
    ])
    // fewer ids are a new read; Far B keeps the name it was given, and
    // only the new answer says the deleted one is gone
    expect(one('labels:byIds').args).toEqual({
      org_id: snap.orgs[0].id,
      ids: ['label-far-b', 'label-gone'],
    })
    expect(chips().map((c) => c.text)).toEqual(['Hardware', 'Far B', 'Loading label…'])
    await answer('labels:byIds', { rows: [far('label-far-b', 'Far B')] })
    expect(chips().map((c) => c.text)).toEqual(['Hardware', 'Far B'])
  })

  it('keeps the chips after a failed read, each removable, with one Try again', async () => {
    await load(labelled())
    await openTask()
    await fail('labels:byIds')
    const failed = chips().slice(1)
    expect(failed).toHaveLength(3)
    for (const chip of failed)
      expect(chip).toEqual({
        text: "Couldn't load this label",
        waiting: false,
        failed: true,
        remove: 'Remove this label',
        disabled: false,
      })
    const retry = document.querySelectorAll<HTMLButtonElement>('[data-labels-retry]')
    expect(retry).toHaveLength(1)
    await act(async () => retry[0].click())
    await answer('labels:byIds', { rows: [far('label-far-a', 'Far A')] })
    expect(chips().map((c) => c.text)).toEqual(['Hardware', 'Far A'])
    expect(document.querySelector('[data-labels-retry]')).toBeNull()
  })

  it('offers Try again when a read fails after the labels were named, keeping their names', async () => {
    const next = labelled()
    next.issueLabels = next.issueLabels.filter((il) => il.label_id !== 'label-gone')
    await load(next)
    await openTask()
    await answer('labels:byIds', {
      rows: [far('label-far-a', 'Far A'), far('label-far-b', 'Far B')],
    })
    expect(document.querySelector('[data-labels-retry]')).toBeNull()
    network.mutation.mockImplementation(async (ref, args) => {
      if (getFunctionName(ref) === 'labels:toggle') {
        snap.issueLabels = snap.issueLabels.filter((il) => il.label_id !== args.label_id)
        publish()
      }
      return null
    })
    // taking Far A off reads Far B again, and that read fails
    await act(async () => removeOf('Far A')?.click())
    expect(one('labels:byIds').args.ids).toEqual(['label-far-b'])
    await fail('labels:byIds')
    // Far B keeps the name it was given, which may be out of date now
    expect(chips().map((c) => [c.text, c.failed])).toEqual([
      ['Hardware', false],
      ['Far B', false],
    ])
    const retry = document.querySelectorAll<HTMLButtonElement>('[data-labels-retry]')
    expect(retry).toHaveLength(1)
    await act(async () => retry[0].click())
    await answer('labels:byIds', { rows: [far('label-far-b', 'Far B renamed')] })
    expect(chips().map((c) => c.text)).toEqual(['Hardware', 'Far B renamed'])
    expect(document.querySelector('[data-labels-retry]')).toBeNull()
  })
})
