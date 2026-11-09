// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOVE_HOLDER_RULE } from '../../convex/model/issues'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The Move window on the real store. WEB holds the FE and BE sub-projects,
   HW holds FW. The open task has no subtask in this view, as when its only
   subtasks are archived, so the dialog asks the server whether a move to
   another top-level project carries any. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
// the live double of the store that loaded last, whose project cache reads
// a case can leave to the client's onUpdate
const double = vi.hoisted(() => ({
  live: null as null | { forceProjectNav(force: 'client' | null): void },
}))
vi.mock('../lib/convex', async () => {
  double.live = (await import('../store/guard/liveDouble.setup')).liveOver(network, {
    taskWindow: 'client',
  })
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
/* Whether the project cache's byIds reads go to onUpdate below, which
   answers them from the world as it stands, and the ids whose next such
   read fails, once each. */
let byIdsHere = false
let failByIds = new Set<string>()
/* The byIds reads open now, each answering again from the world as it
   stands, as the server reruns them after an access change. */
let byIdsOpen = new Set<() => void>()
let world: Snapshot

/** Loads the store on the world above, which `prepare` may change, given
    WEB's id. */
async function load(prepare: (snap: Snapshot, web: string) => void = () => {}) {
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
  prepare(snap, web.id)
  world = snap
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
  const { projectNavStandIn } = await import('../store/projectNavStandIn.setup')
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    // the window's targets, the sub-projects the person may add tasks to in
    // the task's organization, as the server lists them
    if (name === 'projectNav:targets') next(projectNavStandIn(snap, name, args))
    if (name === 'projectNav:byIds') {
      const asked = (args as { ids: string[] }).ids
      if (asked.some((id) => failByIds.has(id))) {
        for (const id of asked) failByIds.delete(id)
        fail?.(new Error('the byIds read failed'))
        return () => {}
      }
      const answer = () => next(projectNavStandIn(snap, name, args))
      byIdsOpen.add(answer)
      answer()
      return () => byIdsOpen.delete(answer)
    }
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
  // the double outlives the store, so each load says where its reads go
  double.live?.forceProjectNav(byIdsHere ? 'client' : null)
  await store.initStore()
  dialogs = await import('./Modals')
}

beforeEach(() => {
  byIdsHere = false
  failByIds = new Set()
  byIdsOpen = new Set()
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

/* Picks sub-project `projectId` among the window's targets once the
   server listed it, then waits for the project cache's answer of it,
   which Move waits for. */
async function chooseTarget(projectId: string) {
  const row = () =>
    document.querySelector<HTMLInputElement>(`[data-target="${projectId}"] input:not(:disabled)`)
  await vi.waitFor(() => {
    if (!row()) throw new Error(`Missing the target ${projectId}`)
  })
  await act(async () => row()?.click())
  await vi.waitFor(() => expect(P.projectState(projectId)).toBe('ok'))
  await act(async () => {})
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

/* QN-1, the lone task in FE with no subtask, as the window's own answer
   sends it. */
function loneAnswer() {
  return {
    state: 'ok',
    task: {
      id: 'lone',
      org_id: orgId,
      project_id: ids.fe,
      num: 1,
      title: 'Lone task',
      description: '',
      status: 'todo',
      priority: 'low',
      paused: false,
      created_at: NOW,
      updated_at: NOW,
      has_subtasks: false,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    },
    level: 'lead',
    labels: [],
    follow: null,
    parent: null,
    subtasks: { rows: [], complete: true },
  }
}

/* Opens the window's read of the task `answer` names with it, and the
   Move window over the task it shows. */
async function openFromAnswer(answer: { task: { id: string } }) {
  P.watchComments(answer.task.id, orgId)
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  await act(async () => {
    windowRead?.(answer)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await showMove(answer.task.id)
}

/* Renders the Move window over the task the window shows now, as the task
   window does each time the store changes. */
async function showMove(id = 'far') {
  const task = P.taskDetail(id)?.view
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
  it('leaves the holders of the subtasks it carries to the server, whose refusal says what to change', async () => {
    carries = false
    await load()
    await openFromAnswer(farAnswer())
    await chooseTarget(ids.fw)
    expect(notes()).toEqual(['Its subtasks move with it, archived ones included.'])
    // the store holds nobody but the signed-in person, so it cannot tell
    // whether Pat, who holds the subtask, may work there: the notes name
    // nobody, Move stays on, and the server checks every holder at full
    // scope
    expect(document.querySelector('[data-move-notes]')?.textContent ?? '').not.toContain('Pat Lee')
    const move = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Move',
    )
    expect(move?.disabled).toBe(false)
    // and asks the server by the task's organization and uuid
    expect(asked.at(-1)).toEqual({ org_id: orgId, id: 'far', project_id: ids.fw })
    // within WEB nothing goes along, and the move is open once the project
    // cache answered BE, which the task window draws again on
    await chooseTarget(ids.be)
    await showMove()
    expect(notes()).toEqual([])
    expect(move?.disabled).toBe(false)
    // the server refuses a move whose subtask holder cannot work there,
    // into FW chosen again, which the cache answers for the move
    await chooseTarget(ids.fw)
    network.mutation.mockImplementation((ref) =>
      getFunctionName(ref) === 'identity:claimMySeats'
        ? Promise.resolve(null)
        : Promise.reject(new ConvexError({ code: 'rule', message: MOVE_HOLDER_RULE })),
    )
    const shown = () => P.taskDetail('far')?.view
    const before = shown()?.project
    P.moveIssue(shown()?.id ?? '', ids.fw)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(window.showToast).toHaveBeenCalledWith(
      expect.stringContaining(
        'Someone assigned to or reviewing a subtask of this task has no access to that sub-project',
      ),
      'error',
    )
    // and the move is taken back
    expect(shown()?.project).toBe(before)
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
    await openFromAnswer(loneAnswer())
    await chooseTarget(ids.fw)
    expect(notes()).toEqual([NOTE])
    expect(asked).toEqual([{ org_id: orgId, id: 'lone', project_id: ids.fw }])
  })

  it('says nothing when none would move, and asks only across top-level projects', async () => {
    carries = false
    await load()
    await openFromAnswer(loneAnswer())
    await chooseTarget(ids.fw)
    expect(notes()).toEqual([])
    await chooseTarget(ids.be)
    expect(notes()).toEqual([])
    expect(asked.map((a) => a.project_id)).toEqual([ids.fw])
  })

  it('tells two sub-projects of one name apart by their numbers, which the project cache does not hold', async () => {
    carries = false
    // BE and a second sub-project of WEB share a name
    await load((snap, web) => {
      const be = snap.projects.find((p) => p.id === ids.be)
      if (!be) throw new Error('no BE')
      be.name = 'Design'
      snap.projects.push({ ...be, id: 'design-6', key: 'DS6', num: 6, parent_id: web })
    })
    const lone = P.issues.find((it) => it.uuid === 'lone')
    if (!lone) throw new Error('no task')
    await openFor(lone.id)
    const label = (id: string) =>
      document.querySelector(`[data-target="${id}"]`)?.textContent?.replace(/\s+/g, ' ').trim()
    await vi.waitFor(() => expect(label('design-6')).toBeDefined())
    // must fail for labels that take their tags from the project cache
    expect(label(ids.be)).toBe('Design #4')
    expect(label('design-6')).toBe('Design #6')
  })

  it("says a failed read of the chosen sub-project with Retry, and turns Move on once Retry's read answers", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    carries = false
    byIdsHere = true
    await load()
    const lone = P.issues.find((it) => it.uuid === 'lone')
    if (!lone) throw new Error('no task')
    await openFor(lone.id)
    const row = () =>
      document.querySelector<HTMLInputElement>(`[data-target="${ids.be}"] input:not(:disabled)`)
    await vi.waitFor(() => expect(row()).not.toBeNull())
    // the project cache's first read of BE fails
    failByIds.add(ids.be)
    await act(async () => row()?.click())
    const note = () => document.querySelector<HTMLElement>('[data-target-note]')
    // the window draws again as the task window does on each change
    await vi.waitFor(() => expect(P.projectState(ids.be)).toBe('failed'))
    await openFor(lone.id)
    expect(note()?.dataset.targetNote).toBe('failed')
    expect(note()?.textContent).toContain("Couldn't open BE.")
    const move = () =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent === 'Move',
      )
    expect(move()?.disabled).toBe(true)
    // must fail for a note whose Retry reads nothing again
    await act(async () => note()?.querySelector<HTMLElement>('[data-target-retry]')?.click())
    await vi.waitFor(() => expect(P.projectState(ids.be)).toBe('ok'))
    await openFor(lone.id)
    expect(move()?.disabled).toBe(false)
    expect(note()).toBeNull()
  })

  it('turns Move off and says so once the chosen sub-project answers without Edit, and the store moves nothing there', async () => {
    carries = false
    byIdsHere = true
    await load()
    const lone = P.issues.find((it) => it.uuid === 'lone')
    if (!lone) throw new Error('no task')
    await openFor(lone.id)
    await chooseTarget(ids.be)
    await openFor(lone.id)
    const move = () =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent === 'Move',
      )
    expect(move()?.disabled).toBe(false)
    // someone lowers the person's access to BE to View while the window is
    // open, so BE and WEB lose the lead they gave and a Viewer grant stays
    for (const p of world.projects)
      if (p.id === ids.be || p.parent_id === undefined) p.lead_id = undefined
    world.access.push({ project_id: ids.be, profile_id: world.profiles[0].id, level: 'viewer' })
    for (const answer of byIdsOpen) answer()
    await vi.waitFor(() => expect(P.levelOn(ids.be)).toBe('viewer'))
    expect(P.projectState(ids.be)).toBe('ok')
    await openFor(lone.id)
    // must fail for a Move that checks only the cache's state
    expect(move()?.disabled).toBe(true)
    expect(document.querySelector('[data-target-note]')?.textContent).toBe(
      'You can no longer move this task into BE.',
    )
    // and the store sends no move there
    network.mutation.mockClear()
    expect(P.moveIssue(lone.id, ids.be)).toBeNull()
    expect(
      network.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === 'issues:move'),
    ).toEqual([])
  })

  it('says at its end that no other sub-project takes the task where the list holds only Current, and not beside another row', async () => {
    carries = false
    /** The person edits only `edits` of WEB's sub-projects, and views WEB. */
    const editing = (edits: () => string[]) => (snap: Snapshot, web: string) => {
      const me = snap.profiles[0].id
      snap.profiles[0].org_role = 'user'
      for (const p of snap.projects) p.lead_id = edits().includes(p.id) ? me : undefined
      snap.access.push({ project_id: web, profile_id: me, level: 'viewer' })
    }
    // FE, the task's own sub-project, alone
    await load(editing(() => [ids.fe]))
    const lone = P.issues.find((it) => it.uuid === 'lone')
    if (!lone) throw new Error('no task')
    await openFor(lone.id)
    const picker = () => document.querySelector<HTMLElement>('[data-target-picker]')
    await vi.waitFor(() => expect(picker()?.dataset.pickerState).toBe('ready'))
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-target]')].map((r) => r.dataset.target),
    ).toEqual([ids.fe])
    // must fail for an end that counts Current as a choice
    expect(picker()?.textContent).toContain('No other sub-project you can move it to.')
    await act(async () => root.unmount())
    root = createRoot(container)
    // with BE as well, one other sub-project to move to, the end says nothing
    await load(editing(() => [ids.fe, ids.be]))
    const again = P.issues.find((it) => it.uuid === 'lone')
    if (!again) throw new Error('no task')
    await openFor(again.id)
    await vi.waitFor(() => expect(picker()?.dataset.pickerState).toBe('ready'))
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-target]')].map((r) => r.dataset.target),
    ).toEqual([ids.be, ids.fe])
    expect(picker()?.textContent).not.toContain('No other sub-project you can move it to.')
  })
})
