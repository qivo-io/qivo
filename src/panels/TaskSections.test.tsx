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
const SECTIONS = ['taskWindow:task', 'taskWindow:links', 'taskWindow:attachments']

let P: Planner
let container: HTMLDivElement
let root: Root
let snap: Snapshot
let subs: Live[]
let opened: Mock<(id: string) => void>

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
  const { IssueDetail } = await import('./IssueDetail')
  const handle = P.handleOf(uuid)
  if (!handle) throw new Error(`missing ${uuid}`)
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
  it('says each list is loading before its answer, never that it is empty', async () => {
    await load()
    await openTask()
    for (const name of SECTIONS) expect(open(name)).toHaveLength(1)
    expect(stateOf('subtasks')).toBe('loading')
    expect(noteOf('subtasks')).toBe('Loading subtasks…')
    expect(section('subtasks').textContent).not.toContain('No subtasks.')
    expect(headingOf('subtasks')).toBe('Subtasks')
    expect(noteOf('links')).toBe('Loading linked tasks…')
    expect(section('links').textContent).not.toContain('No dependencies yet.')
    expect(noteOf('attachments')).toBe('Loading attachments…')
    // the workspace holds the subtasks, but the window waits for the list
    expect(titlesOf('subtasks')).toEqual([])
    expect(progress()).toEqual(['', 'Subtasks are still loading.'])
    expect(rollup()).toEqual(['loading', 'Loading…'])
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
    expect(stateOf('subtasks')).toBe('failed')
    expect(noteOf('subtasks')).toBe("Couldn't load subtasks.Retry")
    expect(progress()).toEqual(['Completion unknown.'])
    expect(rollup()).toEqual(['unknown', 'Unknown'])
    // the thread's failure rows are its own
    expect(document.querySelectorAll('[data-thread-failure]')).toHaveLength(0)
    const retry = section('subtasks').querySelector<HTMLElement>('[data-section-failure] button')
    await act(async () => retry?.click())
    expect(stateOf('subtasks')).toBe('retrying')
    expect(noteOf('subtasks')).toBe('Loading subtasks…')
    expect(progress()).toEqual(['', 'Subtasks are still loading.'])
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    await answer('taskWindow:task', taskAnswer([short(row('kid-1'))]))
    expect(titlesOf('subtasks')).toEqual(['Mount the board'])
    // a failure after the list arrived keeps its rows, and says the newest failed
    await fail('taskWindow:task')
    expect(titlesOf('subtasks')).toEqual(['Mount the board'])
    expect(headingOf('subtasks')).toBe('Subtasks')
    expect(noteOf('subtasks')).toBe("Couldn't load the latest subtasks.Retry")
    expect(progress()).toEqual(['Completion unknown.', 'Not every subtask could be loaded.'])
    await fail('taskWindow:links')
    expect(noteOf('links')).toBe("Couldn't load linked tasks.Retry")
    await fail('taskWindow:attachments')
    expect(noteOf('attachments')).toBe("Couldn't load attachments.Retry")
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
    const remove = far.querySelector<HTMLButtonElement>('.task-related-remove')
    expect(remove?.disabled).toBe(true)
    expect(await hintOf(remove)).toBe('Available once every task has loaded')
    // opening it asks for its handle, and the window waits for it
    await act(async () => far.querySelector<HTMLElement>('button')?.click())
    expect(opened).toHaveBeenCalledWith('QN-39')
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

  it('keeps the removal of a link the workspace does not hold yet waiting, between held tasks', async () => {
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
    expect(removeOf('QN-32')?.disabled).toBe(true)
    expect(await hintOf(removeOf('QN-32'))).toBe('Available once every task has loaded')
    expect(removeOf('QN-31')?.disabled).toBe(false)
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
    // removing it waits for the workspace's row
    const remove = row2?.querySelector<HTMLButtonElement>('[aria-label="Remove attachment"]')
    expect(remove?.disabled).toBe(true)
    expect(await hintOf(remove)).toBe('Available once every task has loaded')
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

  it('offers no new subtask in the picker once the whole list holds the cap', async () => {
    await load()
    await openTask()
    await act(async () =>
      document.querySelector<HTMLElement>('button[aria-label="Add subtask"]')?.click(),
    )
    // the picker opens a frame after the press
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
    // the candidates, by key: a picker row starts with its key
    const offered = () =>
      [...document.querySelectorAll('button')]
        .map((b) => b.textContent ?? '')
        .filter((text) => /^QN-\d+/.test(text))
        .map((text) => text.match(/^QN-\d+/)?.[0])
    expect(offered()).toContain('QN-31')
    // the server lists 100 subtasks while the workspace holds three
    const far = Array.from({ length: LIMITS.subtasks.max - 3 }, (_, n) =>
      short(task(`far-${n}`, 100 + n, { title: `Step ${n}`, parent_id: 'fam' })),
    )
    await answer(
      'taskWindow:task',
      taskAnswer([short(row('kid-1')), short(row('kid-2')), short(row('kid-ro')), ...far]),
    )
    expect(offered()).not.toContain('QN-31')
    // the current subtasks Mira can edit stay listed, to take off
    expect(offered()).toEqual(expect.arrayContaining(['QN-28', 'QN-29']))
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

describe('while a large workspace still loads', { timeout: 20_000 }, () => {
  // 12,800 task numbers make 64 task windows; the last starts at fc000000
  const LAST_WINDOW = 'fc000000'

  /* The family task in the first window and its 100 subtasks in the last,
     which answers nothing while the workspace loads in stages. */
  async function staged() {
    const next = fixture()
    next.orgs[0].next_issue_num = 64 * 200
    next.issues = next.issues.filter(
      (t) => t.id !== 'kid-1' && t.id !== 'kid-2' && t.id !== 'kid-ro',
    )
    const family = next.issues.find((t) => t.id === 'fam')
    if (!family) throw new Error('missing the family task')
    Object.assign(family, { id: '01000000-fam', has_subtasks: true })
    next.links = []
    next.attachments = []
    next.messages = []
    for (let n = 0; n < LIMITS.subtasks.max; n++)
      next.issues.push(
        task(`fd${String(n).padStart(6, '0')}-kid`, 100 + n, {
          title: `Step ${n + 1}`,
          parent_id: '01000000-fam',
        }),
      )
    await load(next, async () => {
      const { STAGES } = await import('../store/liveParts')
      STAGES.batch = Number.POSITIVE_INFINITY
      // the double this store's modules made
      double.live?.holdWindow(LAST_WINDOW)
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    return next
  }

  it('lists the subtasks still to arrive, keeps their removal and the task menu waiting, and stays at the cap', async () => {
    const next = await staged()
    expect(P.stillLoading()).not.toBeNull()
    await openTask('01000000-fam')
    const kids = next.issues.filter((t) => t.parent_id === '01000000-fam')
    // the server's lists, before the workspace holds any subtask
    await act(async () => {
      one('taskWindow:task').deliver({
        ...taskAnswer([], true, false, '01000000-fam'),
        subtasks: { rows: kids.map((kid) => short(kid)), complete: true },
      })
    })
    await answer('taskWindow:links', linksAnswer([], []))
    await answer('taskWindow:attachments', filesAnswer([]))
    expect(headingOf('subtasks')).toBe(`Subtasks (${LIMITS.subtasks.max})`)
    for (const name of ['subtasks', 'links', 'attachments']) expect(stateOf(name)).toBe('complete')
    const first = section('subtasks').querySelector('[data-related-task="QN-100"]')
    expect(first?.textContent).toContain('Step 1')
    const remove = first?.querySelector<HTMLButtonElement>('.task-related-remove')
    expect(remove?.disabled).toBe(true)
    expect(await hintOf(remove)).toBe('Available once every task has loaded')
    // the cap counts the whole list, which the workspace holds none of yet
    const add = document.querySelector<HTMLButtonElement>('[aria-label="Add subtask"]')
    expect(add?.disabled).toBe(true)
    expect(await hintOf(add)).toBe(
      `This task has ${LIMITS.subtasks.max} active subtasks, the most a task can have. Archive or remove one of them first.`,
    )
    // moving, archiving and deleting still wait for every task
    await act(async () =>
      document.querySelector<HTMLElement>('[aria-label="Task actions"]')?.click(),
    )
    const move = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Move to sub-project'),
    )
    const fate = document.querySelector<HTMLButtonElement>('[data-task-fate]')
    expect(move?.disabled).toBe(true)
    expect(fate?.disabled).toBe(true)
    expect(await hintOf(move)).toBe('Available once every task has loaded')
    expect(await hintOf(fate)).toBe('Available once every task has loaded')
  })
})
