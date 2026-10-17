// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import type { ProjectRemovalSummary } from '../store/planner'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The Archive or delete windows on the real store, fed one snapshot. Mira
   (me) is a standard user who leads Plan and only views Docs. In Work, under
   Plan, QN-1 has subtasks QN-2 (Done), QN-3 (To Do) and QN-4 (In Progress).
   QN-5 has QN-6 in Manuals, under Docs, and subtasks Mira can't see. QN-7 is
   Done and has no subtasks. The windows call the store as their callers do;
   the network records each write and answers it as the test says. The clock
   is fixed, so the window's one-second pause after asking again is under the
   test's control. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

type Planner = typeof import('../store/planner')['P']
type Modals = typeof import('./Modals')
type Task = Snapshot['issues'][number]

const NOW = new Date(2026, 9, 15, 10, 0)
const AT = '2026-09-14T08:00:00.000Z'

let P: Planner
let dialogs: Modals
let snap: Snapshot
let deliver: (snapshot: Snapshot) => void
let container: HTMLDivElement
let root: Root
// the server's answer per mutation name; a write without one never settles
let answers: Record<string, () => Promise<null>>
// the answers to projects.removalSummary, in order; none means it never settles
let summaries: (() => Promise<ProjectRemovalSummary>)[]

function fixture() {
  const next = plannerFixture()
  const org = next.orgs[0].id
  const me = next.profiles[0]
  Object.assign(me, { id: 'mira', name: 'Mira Holm', org_role: 'user' })
  next.myProfileIds = ['mira']
  next.profiles.push({ ...me, id: 'daniel', name: 'Daniel Berg', auth_user_id: 'account-daniel' })
  const base = next.projects[0]
  next.projects = [
    { ...base, id: 'plan', type: 'meta', key: 'PLAN', name: 'Plan', lead_id: 'mira' },
    { ...base, id: 'work', type: 'project', key: 'WORK', num: 2, name: 'Work', parent_id: 'plan' },
    { ...base, id: 'docs', type: 'meta', key: 'DOC', num: 3, name: 'Docs', lead_id: 'daniel' },
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
  const task = (id: string, num: number, extra: Partial<Task> = {}): Task => ({
    id,
    org_id: org,
    project_id: 'work',
    num,
    title: `Task ${id}`,
    description: '',
    status: 'todo',
    priority: 'low',
    paused: false,
    created_at: AT,
    updated_at: AT,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
    ...extra,
  })
  next.issues.push(
    task('root', 1, { status: 'progress' }),
    task('done-sub', 2, { parent_id: 'root', status: 'done' }),
    task('todo-sub', 3, { parent_id: 'root' }),
    task('busy-sub', 4, { parent_id: 'root', status: 'progress' }),
    task('mixed', 5, { has_hidden_subtasks: true }),
    task('read-only', 6, { parent_id: 'mixed', project_id: 'manuals', status: 'review' }),
    task('finished', 7, { status: 'done' }),
  )
  return next
}

async function load() {
  vi.resetModules()
  snap = fixture()
  answers = {}
  summaries = []
  network.query.mockImplementation((ref) =>
    getFunctionName(ref) === 'projects:removalSummary'
      ? (summaries.shift()?.() ?? new Promise(() => {}))
      : Promise.resolve(null),
  )
  network.onUpdate.mockImplementation((ref, _args, next) => {
    if (getFunctionName(ref) === 'snapshot:forMe') {
      deliver = (snapshot) => next(structuredClone(snapshot))
      deliver(snap)
    }
    return () => {}
  })
  network.mutation.mockImplementation((ref) => {
    const name = getFunctionName(ref)
    if (name === 'identity:claimMySeats') return Promise.resolve(null)
    return answers[name]?.() ?? new Promise(() => {})
  })
  const store = await import('../store/planner')
  P = store.P
  await store.initStore()
  dialogs = await import('./Modals')
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  // Radix measures the settings page's select anchors
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await load()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
  network.mutation.mockReset()
  network.query.mockReset()
})

/* Lets the awaited writes and the count settle. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}
function find<T extends Element = HTMLElement>(selector: string) {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('[data-modal-shell] button')]
const button = (label: string) => {
  const match = buttons().find((b) => b.textContent === label)
  if (!match) throw new Error(`Missing button ${label}`)
  return match
}
const labels = () => buttons().map((b) => b.textContent)
const has = (selector: string) => document.querySelector(selector) !== null
const text = (selector: string) => find(selector).textContent
const reasonLabel = () => text('[data-fate-reason-field] > div')
const writes = () =>
  network.mutation.mock.calls
    .map(([ref, args]) => ({ name: getFunctionName(ref), args }))
    .filter((w) => w.name !== 'identity:claimMySeats')
async function click(element: HTMLElement) {
  await act(async () => element.click())
}
async function type(value: string) {
  const area = find<HTMLTextAreaElement>('[data-fate-reason]')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(area, value)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const choose = (fate: 'archive' | 'delete') =>
  click(find(`[data-fate-card="${fate}"] input[type="radio"]`))
const subtasks = () => find<HTMLButtonElement>('[data-subtask-choice]')
const handle = (uuid: string) => P.issues.find((it) => it.uuid === uuid)?.id ?? ''

/* Opens the task window on `uuid`, wired to the store as the task window does. */
async function openTask(uuid: string) {
  const onClose = vi.fn()
  await act(async () =>
    root.render(
      <TooltipProvider>
        <dialogs.ArchiveOrDeleteTaskModal
          key={uuid}
          issueId={handle(uuid)}
          onClose={onClose}
          onArchive={(reason, keep) => P.archiveIssue(handle(uuid), reason, keep)}
          onDelete={(subs, reason) => P.deleteIssue(handle(uuid), subs, true, reason)}
        />
      </TooltipProvider>,
    ),
  )
  await settle()
  return onClose
}

describe('Archive or delete a task', () => {
  it('archives the subtasks with the task while the box is checked', async () => {
    answers['issues:archive'] = () => Promise.resolve(null)
    await openTask('root')
    expect(text('[data-fate-lead]')).toBe('QN-1 has 3 subtasks, 2 of them unfinished.')
    const heading = find('[data-fate-subtasks] > div')
    expect(heading.textContent).toBe('Also archives 3 subtasks:')
    expect(heading.className).toContain('text-danger')
    expect(subtasks().getAttribute('aria-checked')).toBe('true')
    expect(text('[data-fate-card="archive"]')).toContain('Also archive the 3 subtasks')
    await type('Moved to the 2.6 plan')
    await click(button('Archive'))
    await settle()
    expect(writes()).toEqual([
      {
        name: 'issues:archive',
        args: expect.objectContaining({ id: 'root', reason: 'Moved to the 2.6 plan' }),
      },
    ])
    expect(writes()[0].args).not.toHaveProperty('keep_subtasks')
  })

  it('archives the task alone and keeps the subtasks once the box is cleared', async () => {
    answers['issues:archive'] = () => Promise.resolve(null)
    await openTask('root')
    await click(subtasks())
    expect(text('[data-fate-subtasks] > div')).toBe('Keeps 3 subtasks:')
    expect(text('[data-fate-card="archive"]')).toContain(
      'They stay in their projects. Those directly under it become top-level tasks.',
    )
    // the checkbox sits outside the card's label, so it never switches cards
    expect(find<HTMLInputElement>('[data-fate-card="archive"] input').checked).toBe(true)
    await type('Splitting it up')
    await click(button('Archive'))
    await settle()
    expect(writes()).toEqual([
      {
        name: 'issues:archive',
        args: expect.objectContaining({ id: 'root', keep_subtasks: true }),
      },
    ])
    expect(P.issues.find((it) => it.uuid === 'todo-sub')?.parent).toBeNull()
  })

  it('requires a reason to archive unfinished work, and asks none for a Done task', async () => {
    answers['issues:archive'] = () => Promise.resolve(null)
    await openTask('root')
    expect(reasonLabel()).toBe('Reason (required)')
    expect(button('Archive').disabled).toBe(true)
    await type('   ')
    expect(button('Archive').disabled).toBe(true)
    await click(button('Archive'))
    expect(writes()).toEqual([])

    await openTask('finished')
    expect(text('[data-fate-lead]')).toBe('QN-7 is Done.')
    expect(has('[data-fate-reason]')).toBe(false)
    expect(has('[data-subtask-choice]')).toBe(false)
    expect(button('Archive').disabled).toBe(false)
    await click(button('Archive'))
    await settle()
    expect(writes()).toEqual([
      { name: 'issues:archive', args: expect.objectContaining({ id: 'finished' }) },
    ])
    expect(writes()[0].args).not.toHaveProperty('reason')
  })

  it('makes the reason optional for a delete and keeps what was typed', async () => {
    answers['issues:deleteDeep'] = () => Promise.resolve(null)
    await openTask('root')
    await type('Duplicate of QN-90')
    await choose('delete')
    expect(reasonLabel()).toBe('Reason (optional)')
    expect(text('[data-fate-reason-field]')).toContain('Shown in Deleted items.')
    expect(find<HTMLTextAreaElement>('[data-fate-reason]').value).toBe('Duplicate of QN-90')
    expect(text('[data-fate-subtasks] > div')).toBe('Also deletes 3 subtasks:')
    await click(button('Delete 4 tasks'))
    await settle()
    expect(writes()).toEqual([
      {
        name: 'issues:deleteDeep',
        args: expect.objectContaining({
          id: 'root',
          subtask_ids: ['done-sub', 'todo-sub', 'busy-sub'],
          reason: 'Duplicate of QN-90',
        }),
      },
    ])
  })

  it('labels the delete by what it takes along', async () => {
    await openTask('root')
    await choose('delete')
    expect(labels()).toContain('Delete 4 tasks')
    await click(subtasks())
    expect(labels()).toContain('Delete QN-1')
    expect(labels()).not.toContain('Delete 4 tasks')
    expect(text('[data-fate-subtasks] > div')).toBe('Keeps 3 subtasks:')
    await openTask('finished')
    await choose('delete')
    expect(button('Delete QN-7').disabled).toBe(false)
  })

  it("refuses to archive with a subtask in a project I can't edit, until the subtasks are kept", async () => {
    answers['issues:archive'] = () => Promise.resolve(null)
    await openTask('mixed')
    expect(text('[data-fate-lead]')).toBe(
      "QN-5 has 1 subtask, which is unfinished. At least one is in a project you can't edit. Keep the subtasks, or ask an organization admin.",
    )
    expect(text('[data-fate-subtask="QN-6"]')).toContain('View only')
    expect(text('[data-fate-subtasks]')).toContain("More subtasks in projects you can't open")
    await type('Parked')
    expect(button('Archive').disabled).toBe(true)
    await click(button('Archive'))
    expect(writes()).toEqual([])

    await click(subtasks())
    expect(text('[data-fate-lead]')).toBe('QN-5 has 1 subtask, which is unfinished.')
    expect(button('Archive').disabled).toBe(false)
    await click(button('Archive'))
    await settle()
    expect(writes()).toEqual([
      {
        name: 'issues:archive',
        args: expect.objectContaining({ id: 'mixed', keep_subtasks: true }),
      },
    ])
  })

  it("says why subtasks I can't delete stay, and deletes the task alone", async () => {
    answers['issues:deleteDeep'] = () => Promise.resolve(null)
    await openTask('mixed')
    await choose('delete')
    expect(has('[data-subtask-choice]')).toBe(false)
    expect(text('[data-fate-card="delete"]')).toContain(
      "You can't delete its subtasks, so they stay in their projects and become top-level tasks.",
    )
    expect(text('[data-fate-subtasks] > div')).toBe('Keeps 1 subtask:')
    await click(button('Delete QN-5'))
    await settle()
    expect(writes()).toEqual([
      { name: 'issues:deleteDeep', args: expect.objectContaining({ id: 'mixed' }) },
    ])
    expect(writes()[0].args).not.toHaveProperty('subtask_ids')
  })

  it('warns that subtasks I cannot see can refuse the archive', async () => {
    snap.issues = snap.issues.filter((it) => it.id !== 'read-only')
    await act(async () => deliver(snap))
    await openTask('mixed')
    expect(text('[data-fate-lead]')).toBe(
      "QN-5 has subtasks in projects you can't open. If any of them is in a project you can't edit, the archive is refused.",
    )
    expect(text('[data-fate-card="archive"]')).toContain('Also archive its subtasks')
    await click(subtasks())
    expect(text('[data-fate-lead]')).toBe("QN-5 has subtasks in projects you can't open.")
  })

  it('waits for the server, refuses to close meanwhile, and stays open on a refusal', async () => {
    let refuse: (error: Error) => void = () => {}
    answers['issues:deleteDeep'] = () => new Promise((_, reject) => (refuse = reject))
    const onClose = await openTask('root')
    await choose('delete')
    await click(button('Delete 4 tasks'))
    expect(button('Deleting…').disabled).toBe(true)
    await click(button('Cancel'))
    await click(find('[data-modal-shell] button[aria-label="Close"]'))
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => refuse(new Error('the subtasks changed')))
    await settle()
    expect(button('Delete 4 tasks').disabled).toBe(false)
    expect(window.showToast).toHaveBeenCalled()
    expect(P.issues.find((it) => it.uuid === 'root')).toBeDefined()
    // the lists did not change, so the window does not ask again
    expect(text('[data-task-fate]')).not.toContain('The subtasks changed')
    await click(button('Cancel'))
    expect(onClose).toHaveBeenCalled()
  })

  it('shows the lists as they are after a refusal, and asks again', async () => {
    let refuse: (error: Error) => void = () => {}
    answers['issues:deleteDeep'] = () => new Promise((_, reject) => (refuse = reject))
    await openTask('root')
    await choose('delete')
    await click(button('Delete 4 tasks'))
    // another person adds a subtask while the delete waits, and the server refuses
    snap.issues.push({ ...snap.issues[2], id: 'late-sub', num: 8, title: 'Task late-sub' })
    await act(async () => deliver(snap))
    await act(async () => refuse(new Error('the subtasks changed')))
    await settle()
    expect(text('[data-task-fate]')).toContain(
      'The subtasks changed while this window was open. Check them and choose again.',
    )
    expect(text('[data-fate-subtasks] > div')).toBe('Also deletes 4 subtasks:')
    expect(labels()).toContain('Delete 5 tasks')
  })

  it('asks a reason when a Done task takes unfinished subtasks along, and none once they stay', async () => {
    // QN-1 itself is Done, while two of its subtasks are not
    snap.issues = snap.issues.map((t) => (t.id === 'root' ? { ...t, status: 'done' } : t))
    await act(async () => deliver(snap))
    answers['issues:archive'] = () => Promise.resolve(null)
    await openTask('root')
    expect(reasonLabel()).toBe('Reason (required)')
    expect(button('Archive').disabled).toBe(true)
    await click(subtasks())
    expect(has('[data-fate-reason]')).toBe(false)
    expect(button('Archive').disabled).toBe(false)
    await click(button('Archive'))
    await settle()
    expect(writes()).toEqual([
      {
        name: 'issues:archive',
        args: expect.objectContaining({ id: 'root', keep_subtasks: true }),
      },
    ])
    expect(writes()[0].args).not.toHaveProperty('reason')
  })

  it('tells assistive technology whether the reason is required, and its hint', async () => {
    await openTask('root')
    const field = () => find<HTMLTextAreaElement>('[data-fate-reason]')
    const hint = () => document.getElementById(field().getAttribute('aria-describedby') ?? '')
    expect(field().getAttribute('aria-required')).toBe('true')
    expect(hint()?.textContent).toBe("Saved to the task's comments.")
    await choose('delete')
    expect(field().getAttribute('aria-required')).toBe('false')
    expect(hint()?.textContent).toBe('Shown in Deleted items.')
  })

  it('asks again when the subtasks changed, and ignores clicks for a second after', async () => {
    answers['issues:deleteDeep'] = () => Promise.resolve(null)
    await openTask('root')
    await choose('delete')
    // another person adds a subtask while the window is open
    snap.issues.push({ ...snap.issues[2], id: 'late-sub', num: 8, title: 'Task late-sub' })
    await act(async () => deliver(snap))
    await click(button('Delete 4 tasks'))
    expect(writes()).toEqual([])
    expect(text('[data-task-fate]')).toContain(
      'The subtasks changed while this window was open. Check them and choose again.',
    )
    expect(text('[data-fate-subtasks] > div')).toBe('Also deletes 4 subtasks:')
    await click(button('Delete 5 tasks'))
    expect(writes()).toEqual([])
    vi.setSystemTime(Date.now() + 1000)
    await click(button('Delete 5 tasks'))
    await settle()
    expect(writes()).toEqual([
      {
        name: 'issues:deleteDeep',
        args: expect.objectContaining({
          subtask_ids: ['done-sub', 'todo-sub', 'busy-sub', 'late-sub'],
        }),
      },
    ])
  })
})

const summary = (over: Partial<ProjectRemovalSummary> = {}): ProjectRemovalSummary => ({
  tasks: 48,
  archived_tasks: 9,
  more: false,
  sub_projects: [
    {
      id: 's1',
      name: 'Site preparation',
      key: 'SITE',
      archived: false,
      tasks: 21,
      archived_tasks: 4,
      more: false,
    },
    {
      id: 's2',
      name: 'Data collection',
      key: 'DATA',
      archived: false,
      tasks: 22,
      archived_tasks: 5,
      more: false,
    },
    {
      id: 's3',
      name: 'Prototype 1',
      key: 'P1',
      archived: true,
      tasks: 5,
      archived_tasks: 0,
      more: false,
    },
  ],
  ...over,
})

/* Opens the project window on Plan, wired to the store as project settings is. */
async function openProject(deleteOnly = false) {
  const onClose = vi.fn()
  const onArchive = vi.fn()
  const plan = P.project('plan')
  if (!plan) throw new Error('Missing Plan')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <dialogs.ArchiveOrDeleteProjectModal
          project={plan}
          deleteOnly={deleteOnly}
          onClose={onClose}
          onArchive={onArchive}
          onDelete={(reason) => P.removeProject('plan', reason)}
        />
      </TooltipProvider>,
    ),
  )
  await settle()
  return { onClose, onArchive }
}

describe('Archive or delete a project', () => {
  it('counts the tasks first, and offers to try again when counting fails', async () => {
    summaries.push(
      () => Promise.reject(new Error('offline')),
      () => Promise.resolve(summary()),
    )
    const { onArchive } = await openProject()
    expect(text('[data-project-fate] [role="alert"]')).toContain("Couldn't count the tasks.")
    expect(button('Archive').disabled).toBe(true)
    await click(button('Archive'))
    expect(onArchive).not.toHaveBeenCalled()

    await click(button('Try again'))
    await settle()
    expect(text('[data-fate-lead]')).toBe(
      'Plan has 3 sub-projects and 48 tasks, including 9 archived tasks.',
    )
    // Archive lists the active sub-projects, Delete every one of them
    expect(text('[data-fate-subprojects] > div')).toBe('Also archives 2 sub-projects:')
    expect(has('[data-fate-subproject="s3"]')).toBe(false)
    await click(button('Archive'))
    expect(onArchive).toHaveBeenCalledTimes(1)
    await choose('delete')
    expect(text('[data-fate-subprojects] > div')).toBe('Also deletes 3 sub-projects:')
    expect(text('[data-fate-subproject="s3"]')).toBe('Prototype 1Archived5 tasks')
    expect(text('[data-fate-card="delete"]')).toContain(
      'Moves the project, its sub-projects and all 48 tasks to Deleted items. You can restore them from there.',
    )
    expect(button('Delete project and 48 tasks').disabled).toBe(false)
  })

  it('waits while counting, with both choices disabled', async () => {
    await openProject()
    expect(text('[data-project-fate] [role="status"]')).toBe('Counting tasks…')
    expect(button('Archive').disabled).toBe(true)
    await choose('delete')
    expect(button('Delete project').disabled).toBe(true)
    expect(has('[data-fate-subprojects]')).toBe(false)
  })

  it('deletes with the reason, and stays open when the server refuses', async () => {
    summaries.push(() => Promise.resolve(summary()))
    answers['projects:deleteDeep'] = () => Promise.reject(new Error('requires the project lead'))
    const { onClose } = await openProject()
    await choose('delete')
    await type('  Trial cancelled  ')
    await click(button('Delete project and 48 tasks'))
    await settle()
    expect(writes()).toEqual([
      {
        name: 'projects:deleteDeep',
        args: expect.objectContaining({ id: 'plan', reason: 'Trial cancelled' }),
      },
    ])
    expect(button('Delete project and 48 tasks').disabled).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    expect(P.project('plan')).toBeDefined()

    answers['projects:deleteDeep'] = () => Promise.resolve(null)
    await click(button('Delete project and 48 tasks'))
    await settle()
    expect(P.project('plan')).toBeUndefined()
  })

  it('waits for the server while deleting, and refuses to close meanwhile', async () => {
    summaries.push(() => Promise.resolve(summary()))
    let refuse: (error: Error) => void = () => {}
    answers['projects:deleteDeep'] = () => new Promise((_, reject) => (refuse = reject))
    const { onClose } = await openProject()
    await choose('delete')
    await click(button('Delete project and 48 tasks'))
    expect(button('Deleting…').disabled).toBe(true)
    await click(button('Cancel'))
    await click(find('[data-modal-shell] button[aria-label="Close"]'))
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => refuse(new Error('requires the project lead')))
    await settle()
    expect(button('Delete project and 48 tasks').disabled).toBe(false)
    await click(button('Cancel'))
    expect(onClose).toHaveBeenCalled()
  })

  it('offers only the delete from Archived projects, without the cards', async () => {
    summaries.push(() =>
      Promise.resolve(summary({ tasks: 1, archived_tasks: 0, sub_projects: [] })),
    )
    await openProject(true)
    expect(text('[data-modal-shell] h2')).toBe('Delete “Plan”?')
    expect(has('[data-fate-card]')).toBe(false)
    expect(text('[data-fate-lead]')).toBe('Plan has 1 task.')
    expect(text('[data-project-fate]')).toContain(
      'Moves the project and its task to Deleted items. You can restore them from there.',
    )
    expect(has('[data-fate-reason]')).toBe(true)
    expect(button('Delete project and 1 task').disabled).toBe(false)
    expect(labels()).not.toContain('Archive')
  })
})

describe('Archived projects', () => {
  it('keeps keyboard focus on the page after a delete', async () => {
    // Plan and Docs are archived, with their sub-projects, and Mira leads both
    for (const p of snap.projects) p.archived_at = AT
    const docs = snap.projects.find((p) => p.id === 'docs')
    if (docs) docs.lead_id = 'mira'
    await act(async () => deliver(snap))
    const settings = await import('./settings/ProjectSettings')
    const version = await import('../store/usePlannerVersion')
    function Live() {
      version.usePlannerVersion()
      return <settings.ArchivedProjectsPage />
    }
    await act(async () =>
      root.render(
        <TooltipProvider>
          <Live />
        </TooltipProvider>,
      ),
    )
    await settle()
    // the delivery without the project, as the server sends it before it answers
    const drop = (id: string) => {
      snap.projects = snap.projects.filter((p) => p.id !== id && p.parent_id !== id)
      deliver(snap)
      return Promise.resolve(null)
    }
    const remove = async (id: string, name: string) => {
      summaries.push(() =>
        Promise.resolve(summary({ tasks: 4, archived_tasks: 0, sub_projects: [] })),
      )
      answers['projects:deleteDeep'] = () => drop(id)
      const del = find<HTMLButtonElement>(`[data-delete-project="${id}"]`)
      del.focus()
      await click(del)
      await settle()
      expect(text('[data-modal-shell] h2')).toBe(`Delete “${name}”?`)
      await click(button('Delete project and 4 tasks'))
      await settle()
      expect(has('[data-modal-shell]')).toBe(false)
      expect(has(`[data-archived-project="${id}"]`)).toBe(false)
    }
    // a cancelled window gives focus back to the row's Delete
    summaries.push(() =>
      Promise.resolve(summary({ tasks: 4, archived_tasks: 0, sub_projects: [] })),
    )
    const plan = find<HTMLButtonElement>('[data-delete-project="plan"]')
    plan.focus()
    await click(plan)
    await settle()
    await click(button('Cancel'))
    // the dialog hands focus back on a timer after it unmounts
    await settle()
    expect(document.activeElement).toBe(find('[data-delete-project="plan"]'))
    // the row left, so focus goes to the next row's first button
    await remove('plan', 'Plan')
    expect(document.activeElement).toBe(find('[data-restore-project="docs"]'))
    // no row is left, so focus goes to the page heading
    await remove('docs', 'Docs')
    expect(document.activeElement).toBe(find('.settings-page-title h1'))
  })
})

describe('the Archive or delete section of project settings', () => {
  /* Renders a project's settings page, re-rendering on store changes as the
     app's shell does. */
  async function openSettings(projectId: string) {
    const setPage = vi.fn()
    const onLeaving = vi.fn()
    const settings = await import('./settings/ProjectSettings')
    const version = await import('../store/usePlannerVersion')
    function Live() {
      version.usePlannerVersion()
      return <settings.ProjectPage projectId={projectId} setPage={setPage} onLeaving={onLeaving} />
    }
    await act(async () =>
      root.render(
        <TooltipProvider>
          <Live />
        </TooltipProvider>,
      ),
    )
    await settle()
    return { setPage, onLeaving }
  }
  const section = () => find('[data-project-removal]')
  const open = () => find<HTMLButtonElement>('[data-remove-project]')

  it("opens the window for the project's lead, and leaves the page once the delete is done", async () => {
    summaries.push(() => Promise.resolve(summary()))
    answers['projects:deleteDeep'] = () => Promise.resolve(null)
    const { setPage, onLeaving } = await openSettings('plan')
    expect(section().querySelector('legend')?.textContent).toBe('Archive or delete')
    expect(section().textContent).toContain(
      'Archive hides it and its 1 sub-project. Delete moves them and their tasks to Deleted items.',
    )
    // the section replaced the Danger zone, the page's only danger-toned box
    expect(has('fieldset.settings-section legend.text-danger')).toBe(false)
    expect(open().disabled).toBe(false)
    await click(open())
    await settle()
    expect(text('[data-modal-shell] h2')).toBe('Archive or delete project')
    await choose('delete')
    await click(button('Delete project and 48 tasks'))
    await settle()
    expect(onLeaving).toHaveBeenCalledWith('plan')
    expect(setPage).toHaveBeenLastCalledWith('projects')
    expect(window.showToast).toHaveBeenCalledWith('Deleted “Plan”')
    expect(has('[data-modal-shell]')).toBe(false)
  })

  it('disables it for everyone else, with the reason and without counts', async () => {
    await openSettings('docs')
    expect(section().textContent).toContain(
      'Archive hides it and its sub-projects. Delete moves them and their tasks to Deleted items.',
    )
    expect(open().disabled).toBe(true)
    await click(open())
    expect(has('[data-modal-shell]')).toBe(false)
    // only the lead may read the counts, so nobody asked for them
    expect(network.query.mock.calls.map(([ref]) => getFunctionName(ref))).not.toContain(
      'projects:removalSummary',
    )
  })
})

describe('Settings while a project page deletes its project', () => {
  /* Settings as the app holds it: the page in state, every page committed. */
  async function openSettings(page: string) {
    const shown: string[] = []
    const { SettingsScreen } = await import('./Settings')
    const version = await import('../store/usePlannerVersion')
    const react = await import('react')
    function Live() {
      version.usePlannerVersion()
      const [current, setCurrent] = react.useState(page)
      react.useEffect(() => {
        shown.push(current)
      }, [current])
      return (
        <SettingsScreen
          page={current}
          setPage={setCurrent}
          onExit={vi.fn()}
          onNewProject={vi.fn()}
          onNewSubProject={vi.fn()}
          onOpenArchive={vi.fn()}
        />
      )
    }
    await act(async () =>
      root.render(
        <TooltipProvider>
          <Live />
        </TooltipProvider>,
      ),
    )
    await settle()
    return shown
  }
  // the delivery without Plan, as the server sends it before it answers
  const dropPlan = () => {
    snap.projects = snap.projects.filter((p) => p.id !== 'plan' && p.parent_id !== 'plan')
    snap.issues = snap.issues.filter((it) => it.project_id !== 'work')
    deliver(snap)
  }

  it('goes from the page to the project list, never to another page first', async () => {
    summaries.push(() => Promise.resolve(summary()))
    answers['projects:deleteDeep'] = () => {
      dropPlan()
      return Promise.resolve(null)
    }
    const shown = await openSettings('project:plan')
    await click(find<HTMLButtonElement>('[data-remove-project]'))
    await settle()
    await choose('delete')
    await click(button('Delete project and 48 tasks'))
    await settle()
    expect(shown).toEqual(['project:plan', 'projects'])
  })

  it('still sends a page elsewhere when someone else deletes its project', async () => {
    const shown = await openSettings('project:plan')
    await act(async () => dropPlan())
    await settle()
    expect(shown).toEqual(['project:plan', 'account'])
  })
})
