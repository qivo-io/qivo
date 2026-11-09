import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../../convex/lib/limits'
import type { RelationCandidate } from '../../convex/lib/relationPicker'
import { linkBlock } from '../lib/taskCaps'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* The writes behind the task window's relation pickers and the ×s of its
   Subtasks and Linked tasks, on the real store over the live double: each
   takes the window's task as the window shows it (held, or from its own
   answer, convex/taskWindow.ts task) and a picker's row as the server
   offered it (convex/lib/relationPicker.ts), sends what the person saw as
   the expected values, marks a write with an end from a server answer
   (WriteAbout.answer), and refuses a parent it cannot resolve rather than
   sending a detach or a top-level task. Mira leads Plan, where Work is.
   QN-1 is held; QN-40 is on the server but not in the workspace, and so
   are the picker's tasks QN-45 and QN-46. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => {
  const { liveOver } = await import('./guard/liveDouble.setup')
  return { convex: network, live: liveOver(network, { taskWindow: 'client' }) }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

type Planner = typeof import('./planner')['P']
type Task = Snapshot['issues'][number]
type Live = { name: string; deliver: (value: unknown) => void; closed: boolean }
type Pending = {
  name: string
  args: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

const AT = '2026-09-14T08:00:00.000Z'
const MIRA = 'mira'
const FAR = 'fd000000-0000-4000-8000-000000000040'
const PICK = 'fd000000-0000-4000-8000-000000000045'
const PICK_2 = 'fd000000-0000-4000-8000-000000000046'
const OLD_PARENT = 'fd000000-0000-4000-8000-000000000039'
const H = 'QN-40'
const UNKNOWN = "Couldn't set the parent task, because Qivo cannot find it here."

let P: Planner
let store: typeof import('./planner')
let snap: Snapshot
let subs: Live[]
let writes: Pending[]
let ORG: string
// delivers the workspace again, as the server sends a change
let workspace: (next: Snapshot) => void

const turn = () => new Promise((resolve) => setTimeout(resolve, 0))

const task = (id: string, num: number, over: Partial<Task> = {}): Task => ({
  id,
  org_id: ORG,
  project_id: 'work',
  num,
  title: `Task ${num}`,
  description: '',
  status: 'todo',
  priority: 'medium',
  paused: false,
  created_at: AT,
  updated_at: AT,
  status_at: AT,
  has_hidden_subtasks: false,
  has_hidden_parent: false,
  ...over,
})
const far = (over: Partial<Task> = {}) => task(FAR, 40, { title: 'Tune the antenna', ...over })
/* Task `row` as a short row of an answer. */
const short = (row: Task, has_subtasks = false) => {
  const {
    description: _text,
    parent_id: _parent,
    has_hidden_subtasks: _hidden,
    has_hidden_parent: _hiddenParent,
    ...rest
  } = row
  return { ...rest, has_subtasks, level: 'lead' as const }
}
/* Task `row` as a relation picker's row, with the parent pair the
   Subtasks picker sends. */
const pickerRow = (row: Task, pair: Partial<RelationCandidate> = {}): RelationCandidate => {
  const { has_subtasks: _group, ...rest } = short(row)
  return { ...rest, ...pair }
}
const okAnswer = (row: Task = far(), extra: Record<string, unknown> = {}) => ({
  state: 'ok',
  task: { ...row, has_subtasks: false },
  level: 'lead',
  labels: [],
  follow: null,
  parent: null,
  subtasks: { rows: [], complete: true },
  ...extra,
})

function fixture() {
  const next = plannerFixture()
  ORG = next.orgs[0].id
  const me = next.profiles[0]
  Object.assign(me, { id: MIRA, name: 'Mira Holm', org_role: 'user' })
  next.myProfileIds = [MIRA]
  const base = next.projects[0]
  next.projects = [
    { ...base, id: 'plan', type: 'meta', key: 'PLAN', name: 'Plan', lead_id: MIRA },
    { ...base, id: 'work', key: 'WORK', num: 2, name: 'Work', parent_id: 'plan' },
  ]
  next.orgs[0].next_issue_num = 60
  next.issues.push(task('task-a', 1), task('task-b', 2))
  return next
}

async function load(edit?: (next: Snapshot) => void) {
  vi.resetModules()
  snap = fixture()
  edit?.(snap)
  subs = []
  writes = []
  network.onUpdate.mockImplementation((ref, _args, next) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      workspace = (value) => next(structuredClone(value))
      workspace(snap)
      return () => {}
    }
    const live: Live = { name, deliver: next, closed: false }
    subs.push(live)
    return () => {
      live.closed = true
    }
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockImplementation((ref, args) =>
    getFunctionName(ref) === 'identity:claimMySeats'
      ? Promise.resolve(null)
      : new Promise((resolve, reject) =>
          writes.push({ name: getFunctionName(ref), args, resolve, reject }),
        ),
  )
  store = await import('./planner')
  P = store.P
  await store.initStore()
}

function one(name: string): Live {
  const live = subs.filter((s) => s.name === name && !s.closed)
  expect(live, name).toHaveLength(1)
  return live[0]
}
async function deliver(name: string, value: unknown) {
  one(name).deliver(structuredClone(value))
  await turn()
}
/** Opens the window's read of QN-40 and delivers `answer`. */
async function openFar(answer: unknown = okAnswer()) {
  P.watchComments(FAR, ORG)
  P.showSections({}, true)
  await turn()
  await deliver('taskWindow:task', answer)
  expect(P.detail?.state).toBe('ok')
}
const sent = (name: string) => writes.filter((w) => w.name === name)
function last(name: string): Pending {
  const found = sent(name).at(-1)
  if (!found) throw new Error(`${name} was not sent`)
  return found
}
const marks = () => {
  if (!store.__layerProbe) throw new Error('the layer probe is test-only')
  return store.__layerProbe.answerMarks()
}
const toasts = () =>
  (window.showToast as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[0])

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { showToast: vi.fn(), setTimeout, clearTimeout })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  if (store?.__layerProbe) expect(store.__layerProbe.faults()).toEqual([])
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("the window's own parent", { timeout: 30_000 }, () => {
  it('sets a parent the picker offered on a task the window shows from its answer, with the hidden pair it showed, and shows the new parent at once', async () => {
    await load()
    await openFar(okAnswer(far({ has_hidden_parent: true })))
    // without the picker's row, nothing goes
    await expect(P.updateIssue(H, { parent: PICK })).resolves.toBe(false)
    expect(sent('issues:update')).toEqual([])
    const row = pickerRow(task(PICK, 45, { title: 'Build the mast', remaining_hours: 4 }))
    void P.updateIssue(H, { parent: PICK }, { parentRow: row })
    expect(last('issues:update').args).toEqual({
      org_id: ORG,
      id: FAR,
      patch: { parent_id: PICK },
      expected: { parent_id: null, has_hidden_parent: true },
    })
    expect(marks()).toEqual(['issues:update'])
    // the window's Parent row, a group now, without hours of its own
    expect(P.detail?.parent).toMatchObject({ uuid: PICK, title: 'Build the mast', isGroup: true })
    expect(P.detail?.parent?.remaining).toBeUndefined()
    expect(P.detail?.view?.hasHiddenParent).toBe(false)
    // a refusal takes the parent away again
    last('issues:update').reject(new ConvexError({ code: 'rule', message: 'Not allowed' }))
    await turn()
    expect(P.detail?.parent).toBeNull()
    expect(P.detail?.view?.hasHiddenParent).toBe(true)
  })
})

describe('the Subtasks writes', { timeout: 30_000 }, () => {
  it('makes a task the workspace does not hold a subtask from the picker’s row, with its parent pair as expected, and lists it at once', async () => {
    await load()
    await openFar()
    const row = pickerRow(task(PICK, 45, { title: 'Mount it' }), { parent_id: OLD_PARENT })
    const end = { uuid: PICK, row, parent: OLD_PARENT, hiddenParent: false }
    const saved = P.setSubtaskParent(H, end, true)
    expect(last('issues:update').args).toEqual({
      org_id: ORG,
      id: PICK,
      patch: { parent_id: FAR },
      expected: { parent_id: OLD_PARENT, has_hidden_parent: false },
    })
    expect(marks()).toEqual(['issues:update'])
    expect(P.sections?.subtasks.rows.map((r) => r.uuid)).toEqual([PICK])
    expect(P.detail?.view?.isGroup).toBe(true)
    last('issues:update').resolve(null)
    await expect(saved).resolves.toBe(true)
  })

  it('sends a hidden parent pair as the person saw it, and takes the row back off when refused', async () => {
    await load()
    await openFar()
    const end = {
      uuid: PICK,
      row: pickerRow(task(PICK, 45), { has_hidden_parent: true }),
      parent: null,
      hiddenParent: true,
    }
    const saved = P.setSubtaskParent(H, end, true)
    expect(last('issues:update').args.expected).toEqual({
      parent_id: null,
      has_hidden_parent: true,
    })
    last('issues:update').reject(new ConvexError({ code: 'rule', message: 'Not allowed' }))
    await expect(saved).resolves.toBe(false)
    expect(P.sections?.subtasks.rows).toEqual([])
  })

  it('takes a subtask the workspace does not hold off with the open task as its expected parent', async () => {
    await load()
    const kid = task(PICK_2, 46, { parent_id: FAR })
    await openFar(okAnswer(far(), { subtasks: { rows: [short(kid)], complete: true } }))
    expect(P.sections?.subtasks.rows.map((r) => r.uuid)).toEqual([PICK_2])
    void P.setSubtaskParent(H, { uuid: PICK_2, parent: FAR, hiddenParent: false }, false)
    expect(last('issues:update').args).toEqual({
      org_id: ORG,
      id: PICK_2,
      patch: { parent_id: null },
      expected: { parent_id: FAR, has_hidden_parent: false },
    })
    expect(P.sections?.subtasks.rows).toEqual([])
  })

  it('creates a subtask under a task the window shows from its answer, and refuses a parent it cannot resolve', async () => {
    await load()
    await openFar()
    const made = P.addIssue({ project: 'work', title: 'New step', parent: H })
    expect(made).not.toBeNull()
    expect(last('issues:create').args).toMatchObject({ parent_id: FAR, title: 'New step' })
    expect(marks()).toEqual(['issues:create'])
    expect(P.sections?.subtasks.rows.map((r) => r.title)).toEqual(['New step'])
    // a parent neither the workspace nor a current answer holds
    expect(P.addIssue({ project: 'work', title: 'Lost', parent: 'QN-999' })).toBeNull()
    expect(sent('issues:create')).toHaveLength(1)
    expect(toasts()).toContain(UNKNOWN)
  })

  it('sends nothing while writes pause, nor for a task the window does not show', async () => {
    await load()
    await expect(
      P.setSubtaskParent(H, { uuid: PICK, parent: null, hiddenParent: false }, true),
    ).resolves.toBe(false)
    const sync = await import('../lib/syncStatus')
    await openFar()
    sync.syncStatus.setSocket({ connected: false, everConnected: true })
    await new Promise((resolve) => setTimeout(resolve, sync.OFFLINE_DELAY_MS + 50))
    const row = pickerRow(task(PICK, 45))
    await expect(
      P.setSubtaskParent(H, { uuid: PICK, row, parent: null, hiddenParent: false }, true),
    ).resolves.toBe(false)
    await expect(P.linkTasks(H, 'blocks', { uuid: PICK })).resolves.toBe(false)
    expect(writes.filter((w) => w.name.startsWith('issues:'))).toEqual([])
  })
})

describe('the Linked tasks writes', { timeout: 30_000 }, () => {
  it('links a task the window shows from its answer in the stored form, marked as from an answer', async () => {
    await load()
    await openFar()
    void P.linkTasks(H, 'blocked_by', { uuid: PICK })
    expect(last('issues:addLink').args).toMatchObject({
      org_id: ORG,
      source_id: PICK,
      target_id: FAR,
      type: 'blocks',
    })
    void P.linkTasks(H, 'relates', { uuid: 'task-a' })
    const relates = last('issues:addLink').args
    expect([relates.source_id, relates.target_id, relates.type]).toEqual(
      ['task-a', FAR].sort().concat('relates'),
    )
    expect(marks()).toEqual(['issues:addLink', 'issues:addLink'])
  })

  it('refuses a new link once the complete links answer holds the limit', async () => {
    await load()
    await openFar()
    const ends = Array.from({ length: LIMITS.links.max }, (_, n) =>
      task(`fd100000-0000-4000-8000-${String(n).padStart(12, '0')}`, 100 + n),
    )
    await deliver('taskWindow:links', {
      state: 'ok',
      links: ends.map((end, n) => ({
        id: `link-${n}`,
        source_id: FAR,
        target_id: end.id,
        type: 'blocks',
        created_at: AT,
      })),
      tasks: ends.map((end) => short(end)),
      complete: true,
    })
    await expect(P.linkTasks(H, 'blocks', { uuid: PICK })).resolves.toBe(false)
    expect(sent('issues:addLink')).toEqual([])
    expect(toasts()).toEqual([linkBlock(ends)])
  })
})
