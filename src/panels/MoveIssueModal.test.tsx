// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The Move window on the real store. WEB holds the FE and BE sub-projects,
   HW holds FW. The open task has no subtask in this view, as when its only
   subtasks are archived, so the dialog asks the server whether a move to
   another top-level project carries any. */

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
type Modals = typeof import('./Modals')

const NOW = '2026-09-14T08:00:00.000Z'
const NOTE = 'Its subtasks move with it, archived ones included.'

let P: Planner
let dialogs: Modals
let container: HTMLDivElement
let root: Root
let ids: Record<'be' | 'fw' | 'fe', string>
let orgId: string
/* The window's read of a task the workspace does not hold, its answers
   and its failures. */
let windowRead: ((value: unknown) => void) | null
let windowFail: ((error: unknown) => void) | null
/* The server's answer to moveCarriesSubtasks, and the arguments it was asked with. */
let carries: boolean
let asked: Record<string, unknown>[]

async function load() {
  vi.resetModules()
  const snap: Snapshot = plannerFixture()
  const org = snap.orgs[0].id
  const base = snap.projects[0]
  const project = (key: string, num: number, extra = {}) => ({
    ...base,
    id: crypto.randomUUID(),
    key,
    num,
    name: key,
    ...extra,
  })
  const web = project('WEB', 1, { type: 'meta' as const })
  const hw = project('HW', 2, { type: 'meta' as const })
  const fe = project('FE', 3, { parent_id: web.id })
  const be = project('BE', 4, { parent_id: web.id })
  const fw = project('FW', 5, { parent_id: hw.id })
  snap.projects = [web, hw, fe, be, fw]
  ids = { be: be.id, fw: fw.id, fe: fe.id }
  orgId = org
  windowRead = null
  windowFail = null
  // Pat edits WEB alone
  snap.profiles.push({
    ...snap.profiles[0],
    id: 'pat',
    name: 'Pat Lee',
    org_role: 'user',
    auth_user_id: 'account-pat',
  })
  snap.access.push({ project_id: web.id, profile_id: 'pat', level: 'user' })
  snap.issues.push({
    id: 'lone',
    org_id: org,
    project_id: fe.id,
    num: 1,
    title: 'Lone task',
    description: '',
    status: 'todo',
    priority: 'low',
    paused: false,
    created_at: NOW,
    updated_at: NOW,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  network.onUpdate.mockImplementation((ref, _args, next, fail) => {
    if (getFunctionName(ref) === 'workspace:whole') next(structuredClone(snap))
    if (getFunctionName(ref) === 'taskWindow:task') {
      windowRead = next
      windowFail = fail
    }
    return () => {}
  })
  network.query.mockImplementation((ref, args) => {
    if (getFunctionName(ref) !== 'issues:moveCarriesSubtasks') return Promise.resolve(null)
    asked.push(args)
    return Promise.resolve(carries)
  })
  network.mutation.mockImplementation((ref) => {
    if (getFunctionName(ref) === 'identity:claimMySeats') return Promise.resolve(null)
    return new Promise(() => {})
  })
  const store = await import('../store/planner')
  P = store.P
  await store.initStore()
  dialogs = await import('./Modals')
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  window.showToast = vi.fn()
  asked = []
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function openFor(key: string) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <dialogs.MoveIssueModal issueId={key} onClose={vi.fn()} onMove={vi.fn()} />
      </TooltipProvider>,
    ),
  )
}

async function chooseTarget(projectId: string) {
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Move to"]')
  if (!select) throw new Error('Missing the Move to select')
  await act(async () => {
    select.value = projectId
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const notes = () => [...document.querySelectorAll('[data-move-note]')].map((n) => n.textContent)

/* QN-40 in FE, which the workspace does not hold, with its subtask QN-41
   assigned to Pat, as the window's own answer sends them, the list whole
   unless `complete` is false. */
function farAnswer(complete = true) {
  const row = (id: string, num: number, extra: Record<string, unknown> = {}) => ({
    id,
    org_id: orgId,
    project_id: ids.fe,
    num,
    title: `Task ${num}`,
    status: 'todo',
    priority: 'low',
    paused: false,
    created_at: NOW,
    updated_at: NOW,
    ...extra,
  })
  return {
    state: 'ok',
    task: {
      ...row('far', 40),
      description: '',
      has_subtasks: true,
      has_hidden_subtasks: !complete,
      has_hidden_parent: false,
    },
    level: 'lead',
    labels: [],
    follow: null,
    parent: null,
    subtasks: {
      rows: [{ ...row('kid', 41, { assignee_id: 'pat' }), has_subtasks: false, level: 'lead' }],
      complete,
    },
  }
}

/* Opens the window's read of QN-40 with `answer`, and the Move window over
   the task it shows. */
async function openFromAnswer(answer: unknown) {
  P.watchComments('far', orgId)
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  await act(async () => {
    windowRead?.(answer)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await showMove()
}

/* Renders the Move window over the task the window shows now, as the task
   window does each time the store changes. */
async function showMove() {
  const task = P.taskDetail('far')?.view
  if (!task) throw new Error('the window shows no task from its answer')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <dialogs.MoveIssueModal issueId={task.id} task={task} onClose={vi.fn()} onMove={vi.fn()} />
      </TooltipProvider>,
    ),
  )
}

describe('the Move window over a task the window shows from its own answer', () => {
  it('names the holders of the subtasks it carries from the answer’s rows', async () => {
    carries = false
    await load()
    await openFromAnswer(farAnswer())
    await chooseTarget(ids.fw)
    expect(notes()).toEqual(['Its subtasks move with it, archived ones included.'])
    expect(document.querySelector('[data-move-blockers]')?.textContent).toContain(
      "Pat Lee is assigned to QN-41 but can't edit",
    )
    const move = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Move',
    )
    expect(move?.disabled).toBe(true)
    // and asks the server by the task's organization and uuid
    expect(asked.at(-1)).toEqual({ org_id: orgId, id: 'far', project_id: ids.fw })
    // within WEB nothing goes along, and the move is open
    await chooseTarget(ids.be)
    expect(notes()).toEqual([])
    expect(move?.disabled).toBe(false)
  })

  it('says it cannot read every subtask while the answer’s list is not whole, and moves nothing', async () => {
    carries = false
    await load()
    await openFromAnswer(farAnswer(false))
    await chooseTarget(ids.be)
    expect(notes()).toEqual(['Not available while Qivo cannot read every subtask of this task.'])
    const move = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Move',
    )
    expect(move?.disabled).toBe(true)
  })

  it('says it waits for the task to be checked once the window’s read fails while it is open, and moves nothing', async () => {
    carries = false
    await load()
    await openFromAnswer(farAnswer())
    await chooseTarget(ids.be)
    expect(notes()).toEqual([])
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {
      windowFail?.(new Error('Server Error'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    quiet.mockRestore()
    expect(P.taskDetail('far')?.state).toBe('failed')
    await showMove()
    expect(notes()).toEqual(['Available once Qivo can check this task for changes.'])
    const move = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Move',
    )
    expect(move?.disabled).toBe(true)
  })
})

describe('Move window', () => {
  it('says the subtasks move when the server knows of ones this view lacks', async () => {
    carries = true
    await load()
    const lone = P.issues.find((it) => it.uuid === 'lone')!
    await openFor(lone.id)
    await chooseTarget(ids.fw)
    expect(notes()).toEqual([NOTE])
    expect(asked).toEqual([{ org_id: lone.org, id: 'lone', project_id: ids.fw }])
  })

  it('says nothing when none would move, and asks only across top-level projects', async () => {
    carries = false
    await load()
    const lone = P.issues.find((it) => it.uuid === 'lone')!
    await openFor(lone.id)
    await chooseTarget(ids.fw)
    expect(notes()).toEqual([])
    await chooseTarget(ids.be)
    expect(notes()).toEqual([])
    expect(asked.map((a) => a.project_id)).toEqual([ids.fw])
  })
})
