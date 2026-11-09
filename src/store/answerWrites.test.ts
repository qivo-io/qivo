import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardAnswer } from '../../convex/lib/board'
import { descriptionForm, FIELD_CHANGED, printOf, trimmedForm } from '../../convex/lib/fieldPrints'
import { LIMITS } from '../../convex/lib/limits'
import type { ViewRow } from '../../convex/lib/viewReads'
import { ASSIGNEE_SIGHT_RULE } from '../../convex/model/issues'
import { limitSentence } from '../lib/fieldLimits'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* Writes on a task the task window shows from its own answer
   (convex/taskWindow.ts task), which the workspace does not hold, on the
   real store over the live double: what each sends, with its expected
   values from the window's painted answer, the paint at once on the window
   and on every view's copy (the `detail` and `view` parts of
   store/layers.ts), what ends that paint, and the paths that fail closed.
   Mira leads Plan, where Work and Bench are, and views Docs, where
   Manuals is. Emil edits Plan and cannot see Docs. QN-40 is on the server
   and in the Board's answer, but not in the workspace. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | { reconnect(only?: readonly string[]): void },
}))
vi.mock('../lib/convex', async () => {
  const { liveOver } = await import('./guard/liveDouble.setup')
  double.live = liveOver(network, { taskWindow: 'client' })
  return { convex: network, live: double.live }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))
// the browser's image re-encoding is not what these writes test, but how
// long it takes is, so a test can hold it until `compression.held` settles
const compression = vi.hoisted(() => ({ held: null as Promise<void> | null }))
vi.mock('../lib/images', async (original) => ({
  ...(await original<typeof import('../lib/images')>()),
  compressImage: async (file: File) => {
    await compression.held
    return file
  },
}))

type Planner = typeof import('./planner')['P']
type Task = Snapshot['issues'][number]
/* One subscription the store made, and whether it stopped. */
type Live = {
  name: string
  args: Record<string, unknown>
  deliver: (value: unknown) => void
  fail: (e: unknown) => void
  closed: boolean
}
/* A write the store sent and the test has not answered yet. */
type Pending = {
  name: string
  args: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

const AT = '2026-09-14T08:00:00.000Z'
const SERVER = '2026-09-14T09:00:00.000Z'
const MIRA = 'mira'
const EMIL = 'emil'
const FAR = 'fd000000-0000-4000-8000-000000000040'
const FAR_KID = 'fd000000-0000-4000-8000-000000000042'
const FAR_KID_2 = 'fd000000-0000-4000-8000-000000000043'
const PARENT = 'fd000000-0000-4000-8000-000000000039'
const H = 'QN-40'
const SLOT = 'board:desktop'
const KEY = '{"board":1}'

let P: Planner
let store: typeof import('./planner')
let snap: Snapshot
let subs: Live[]
let writes: Pending[]
let ORG: string
/* Delivers the workspace again, as a complete transition. */
let publishWorkspace: () => void

/** A turn for the double's microtasks and the store's 0 ms paint timer. */
const turn = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A task as the server stores it, in Work unless `over` says otherwise. */
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
/* QN-40 as the window's answer sends it (convex/lib/workspaceParts.ts
   TaskRow). */
const far = (over: Partial<Task> = {}) =>
  task(FAR, 40, {
    title: 'Tune the antenna',
    description: 'Measure the gain.',
    status: 'progress',
    assignee_id: MIRA,
    ...over,
  })
/* Task `row` as a short row of an answer (convex/lib/taskWindow.ts). */
const short = (row: Task, level = 'lead') => {
  const {
    description: _text,
    parent_id: _parent,
    has_hidden_subtasks: _hidden,
    has_hidden_parent: _hiddenParent,
    ...rest
  } = row
  return { ...rest, has_subtasks: false, level }
}
/* The window's answer for QN-40 (convex/lib/taskWindow.ts readWindowTask). */
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
/* Task `row` as the Board's answer sends it. */
const viewRow = (row: Task): ViewRow => {
  const { description: _text, ...fields } = row
  return { ...fields, has_subtasks: false }
}
const boardAnswer = (rows: ViewRow[]): BoardAnswer => ({
  state: 'ok',
  rows,
  parents: [],
  held_projects: ['work'],
})

/* Mira, Emil and Leo, Plan with Work and Bench, Docs with Manuals, 21
   labels, and the held task QN-1. */
function fixture() {
  const next = plannerFixture()
  ORG = next.orgs[0].id
  const me = next.profiles[0]
  Object.assign(me, { id: MIRA, name: 'Mira Holm', org_role: 'user' })
  next.myProfileIds = [MIRA]
  next.profiles.push(
    { ...me, id: EMIL, name: 'Emil Berg', auth_user_id: 'account-emil' },
    { ...me, id: 'leo', name: 'Leo Park', auth_user_id: 'account-leo' },
  )
  const base = next.projects[0]
  next.projects = [
    { ...base, id: 'plan', type: 'meta', key: 'PLAN', name: 'Plan', lead_id: MIRA },
    { ...base, id: 'work', key: 'WORK', num: 2, name: 'Work', parent_id: 'plan' },
    { ...base, id: 'bench', key: 'BEN', num: 5, name: 'Bench', parent_id: 'plan' },
    { ...base, id: 'docs', type: 'meta', key: 'DOC', num: 3, name: 'Docs', lead_id: 'leo' },
    { ...base, id: 'manuals', key: 'MAN', num: 4, name: 'Manuals', parent_id: 'docs' },
  ]
  next.access.push(
    { project_id: 'docs', profile_id: MIRA, level: 'viewer' },
    { project_id: 'plan', profile_id: EMIL, level: 'user' },
  )
  for (let i = 0; i <= LIMITS.labels.max; i++)
    next.labels.push({
      id: `label-${i}`,
      org_id: ORG,
      name: `Label ${String(i).padStart(2, '0')}`,
      name_lower: `label ${String(i).padStart(2, '0')}`,
      color: '#335577',
      created_at: AT,
    })
  next.orgs[0].next_issue_num = 60
  next.orgs[0].max_attachment_mb = 1
  next.issues.push(task('task-a', 1))
  return next
}

/** Gives Mira Edit on Manuals, as a move into it needs (P.moveIssue). */
const editsManuals = (next: Snapshot) =>
  next.access.push({ project_id: 'manuals', profile_id: MIRA, level: 'user' })

/** Boots the store on the fixture, changed by `edit`. Every write waits
    for the test. */
async function load(edit?: (next: Snapshot) => void) {
  vi.resetModules()
  snap = fixture()
  edit?.(snap)
  subs = []
  writes = []
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      publishWorkspace = () => next(structuredClone({ ...snap, delivered_at: SERVER }))
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
  // the Move window names its targets with the project cache, which a move
  // waits for (P.moveIssue)
  P.nameProjects('the move window', ['work', 'bench', 'manuals'])
  await vi.waitFor(() =>
    expect(['work', 'bench', 'manuals'].map((id) => P.projectState(id))).toEqual([
      'ok',
      'ok',
      'ok',
    ]),
  )
}

const open = (name: string) => subs.filter((s) => s.name === name && !s.closed)
function one(name: string): Live {
  const live = open(name)
  expect(live, name).toHaveLength(1)
  return live[0]
}
async function deliver(name: string, value: unknown) {
  one(name).deliver(structuredClone(value))
  await turn()
}
async function fail(name: string) {
  one(name).fail(new Error('Server Error'))
  await turn()
}
/** Opens the window's read of QN-40 and delivers `answer`. */
async function openFar(answer: unknown = okAnswer()) {
  P.watchComments(FAR, ORG)
  await turn()
  await deliver('taskWindow:task', answer)
  expect(P.detail?.state).toBe('ok')
}
/** Opens the Board on `rows`. */
async function openBoard(rows: ViewRow[]) {
  P.watchBoard(SLOT, KEY)
  await turn()
  await deliver('tasks:board', boardAnswer(rows))
}
const sent = (name: string) => writes.filter((w) => w.name === name)
function last(name: string): Pending {
  const found = sent(name).at(-1)
  if (!found) throw new Error(`${name} was not sent`)
  return found
}
async function answerWith(write: Pending, value: unknown = null) {
  write.resolve(value)
  await turn()
}
const shown = () => {
  const view = P.detail?.view
  if (!view) throw new Error('the window shows no task')
  return view
}
const card = (uuid = FAR) => P.viewTask(SLOT, uuid)
const print = (form: (value: unknown) => string | null, value: string) => printOf(form(value))
const conflict = (field: string) =>
  new ConvexError({
    code: 'conflict',
    reason: FIELD_CHANGED,
    message: `${field} of QN-40 changed since you read it`,
    changes: [{ record: 'task', id: FAR, field, by: 'leo', at: SERVER }],
  })
const probe = () => {
  if (!store.__layerProbe) throw new Error('the layer probe is test-only')
  return store.__layerProbe
}

beforeEach(() => {
  vi.clearAllMocks()
  compression.held = null
  vi.stubGlobal('window', { showToast: vi.fn(), setTimeout, clearTimeout })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  // a fault the store caught (a throw in a paint or an answer) fails the test
  if (store?.__layerProbe) expect(store.__layerProbe.faults()).toEqual([])
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a field written from the window’s own answer', { timeout: 30_000 }, () => {
  it('sends each field with the value the window showed as expected, to the answer’s organization, and paints the window and the Board card at once', async () => {
    await load()
    await openBoard([viewRow(far())])
    await openFar()
    const week = P.isoToWeek('2026-11-02')
    // field, patch, wire patch, expected
    const cases: [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>][] = [
      [
        { title: 'Tune the antenna twice' },
        { title: 'Tune the antenna twice' },
        { title: print(trimmedForm, 'Tune the antenna') },
      ],
      [
        { description: 'Measure the gain at **two** heights.' },
        { description: 'Measure the gain at **two** heights.' },
        { description: print(descriptionForm, 'Measure the gain.') },
      ],
      [{ status: 'review' }, { status: 'review' }, { status: 'progress' }],
      [{ paused: true }, { paused: true }, { paused: false }],
      [{ priority: 'high' }, { priority: 'high' }, { priority: 'medium' }],
      [{ assignee: EMIL }, { assignee_id: EMIL }, { assignee_id: MIRA }],
      [{ reviewer: 'leo' }, { reviewer_id: 'leo' }, { reviewer_id: null }],
      [
        { start: week, end: week + 1 },
        { start_week: '2026-11-02', end_week: '2026-11-09' },
        { start_week: null, end_week: null },
      ],
      [{ due: '2026-12-01' }, { due_date: '2026-12-01' }, { due_date: null }],
      [{ remaining: 6 }, { remaining_hours: 6 }, { remaining_hours: 2 }],
    ]
    for (const [patch, wire, expected] of cases) {
      void P.updateIssue(H, patch)
      expect(last('issues:update').args, JSON.stringify(patch)).toEqual({
        org_id: ORG,
        id: FAR,
        patch: wire,
        expected,
      })
    }
    // every field shows at once in the window and on the Board's card
    const it = shown()
    expect(it.title).toBe('Tune the antenna twice')
    expect(it.description).toBe('Measure the gain at **two** heights.')
    expect([it.status, it.paused, it.priority, it.assignee, it.reviewer]).toEqual([
      'review',
      true,
      'high',
      EMIL,
      'leo',
    ])
    expect([it.start, it.end, it.due, it.remaining]).toEqual([week, week + 1, '2026-12-01', 6])
    expect(card()?.title).toBe('Tune the antenna twice')
    expect(card()?.priority).toBe('high')
    expect(card()?.assignee).toBe(EMIL)
    expect(sent('issues:update')).toHaveLength(cases.length)
  })

  it('sends the parent pair the window showed, hidden or not, and Remove parent takes it off the window', async () => {
    await load()
    const parent = task(PARENT, 39, { title: 'Build the mast' })
    await openFar(okAnswer(far({ parent_id: PARENT }), { parent: short(parent) }))
    expect(shown().parent).toBe('QN-39')
    void P.updateIssue(H, { parent: null })
    expect(last('issues:update').args).toMatchObject({
      patch: { parent_id: null },
      expected: { parent_id: PARENT, has_hidden_parent: false },
    })
    expect(shown().parent).toBeNull()
    expect(P.detail?.parent).toBeNull()
    // a parent the person cannot see: the pair says so, and names no task
    await load()
    await openFar(okAnswer(far({ has_hidden_parent: true })))
    expect(shown().hasHiddenParent).toBe(true)
    void P.updateIssue(H, { parent: null })
    expect(last('issues:update').args).toMatchObject({
      patch: { parent_id: null },
      expected: { parent_id: null, has_hidden_parent: true },
    })
    expect(shown().hasHiddenParent).toBe(false)
    // a new parent comes with the Parent picker's row of it
    // (relationWrites.test.ts), and without one nothing is sent
    await expect(P.updateIssue(H, { parent: 'QN-1' })).resolves.toBe(false)
    expect(sent('issues:update')).toHaveLength(1)
  })
})

describe('the paint of a write from the window’s own answer', { timeout: 30_000 }, () => {
  const renamed = (title: string, extra: Partial<Task> = {}) =>
    okAnswer(far({ title, updated_at: SERVER, ...extra }))

  it('stays after a delivery from before the send and goes with the first current answer after it', async () => {
    await load()
    await openFar()
    void P.updateIssue(H, { title: 'Tune it' })
    // accepted with no delivery since the send: the paint stays
    await answerWith(last('issues:update'))
    expect(shown().title).toBe('Tune it')
    // the answer that holds it, then another change: the window follows
    // the answers, the write's paint is gone
    await deliver('taskWindow:task', renamed('Tune it'))
    await deliver('taskWindow:task', renamed('Leo renamed it'))
    expect(shown().title).toBe('Leo renamed it')
  })

  it('ends at once when the answer that holds it arrives before the write resolves', async () => {
    await load()
    await openFar()
    void P.updateIssue(H, { title: 'Tune it' })
    // Convex delivers what a write changed before the write resolves
    await deliver('taskWindow:task', renamed('Tune it'))
    publishWorkspace()
    await turn()
    expect(probe().layerCount()).toBe(1)
    await answerWith(last('issues:update'))
    expect(probe().layerCount()).toBe(0)
    expect(shown().title).toBe('Tune it')
  })

  it('stays after a delivery on an earlier connection until the answer arrives on the new one', async () => {
    await load()
    await openFar()
    void P.updateIssue(H, { title: 'Tune it' })
    // a delivery after the send that does not hold it yet, then the socket
    // reconnects, and the write is accepted before the task answers again
    await deliver('taskWindow:task', renamed('Tune the antenna'))
    double.live?.reconnect(['workspace:root'])
    await turn()
    await answerWith(last('issues:update'))
    expect(shown().title).toBe('Tune it')
    // the task's answer on the new connection holds it
    await deliver('taskWindow:task', renamed('Tune it'))
    await deliver('taskWindow:task', renamed('Leo renamed it'))
    expect(shown().title).toBe('Leo renamed it')
  })

  it('stays while the window’s read fails, and goes with the next answer', async () => {
    await load()
    await openFar()
    void P.updateIssue(H, { title: 'Tune it' })
    await deliver('taskWindow:task', renamed('Tune the antenna'))
    await fail('taskWindow:task')
    await answerWith(last('issues:update'))
    expect(P.detail?.state).toBe('failed')
    expect(shown().title).toBe('Tune it')
    await deliver('taskWindow:task', renamed('Leo renamed it'))
    expect(shown().title).toBe('Leo renamed it')
  })

  it('takes away only its own paint when refused, and keeps a description draft over the answer’s text as it is now', async () => {
    await load()
    await openFar()
    void P.updateIssue(H, { title: 'Tune it' })
    void P.updateIssue(H, { priority: 'high' })
    const [title] = sent('issues:update')
    title.reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await turn()
    expect(shown().title).toBe('Tune the antenna')
    expect(shown().priority).toBe('high')
    // someone else saves the description while mine waits
    const keepDraft = vi.fn((_shown: unknown) => true)
    void P.updateIssue(
      H,
      { description: 'Mine' },
      { seen: { description: 'Measure the gain.' }, keepDraft },
    )
    expect(shown().description).toBe('Mine')
    await deliver(
      'taskWindow:task',
      okAnswer(far({ description: 'Theirs', updated_at: SERVER }), {}),
    )
    expect(shown().description).toBe('Mine')
    last('issues:update').reject(conflict('description'))
    await turn()
    // the draft keeps, and rebases on the text the window shows now
    expect(keepDraft.mock.calls.map(([text]) => text)).toEqual(['Theirs'])
    expect(shown().description).toBe('Theirs')
    expect(shown().priority).toBe('high')
  })

  it('ends with the answer for a write sent before the tab hid, and is not sent again on return', async () => {
    await load()
    await openBoard([viewRow(far())])
    await openFar()
    void P.updateIssue(H, { title: 'Tune it' })
    // the tab hides: the Board's read stops with its rows kept
    P.watchBoard(SLOT, null)
    await turn()
    await answerWith(last('issues:update'))
    await deliver('taskWindow:task', renamed('Tune it'))
    expect(shown().title).toBe('Tune it')
    // the stopped Board keeps the card painted; shown again, its answer
    // holds the write, and nothing is sent again
    expect(card()?.title).toBe('Tune it')
    P.watchBoard(SLOT, KEY)
    await turn()
    await deliver('tasks:board', boardAnswer([viewRow(far({ title: 'Tune it' }))]))
    expect(card()?.title).toBe('Tune it')
    expect(sent('issues:update')).toHaveLength(1)
  })
})

describe('a write from the window’s own answer fails closed', { timeout: 30_000 }, () => {
  it('sends the window’s values as expected, not an older row a view holds', async () => {
    await load()
    await openBoard([viewRow(far({ title: 'Tune the old antenna', priority: 'low' }))])
    await openFar()
    void P.updateIssue(H, { title: 'Tune it', priority: 'high' })
    expect(last('issues:update').args.expected).toEqual({
      title: print(trimmedForm, 'Tune the antenna'),
      priority: 'medium',
    })
  })

  it('sends the value the window draws as expected, not one a delivery brought that it has yet to draw', async () => {
    await load()
    await openFar()
    // a write still waits, so the store draws the next delivery a moment
    // after it arrives (owe)
    void P.updateIssue(H, { priority: 'high' })
    // Leo renames the task, and a write goes before the window draws it
    one('taskWindow:task').deliver(structuredClone(okAnswer(far({ title: 'Tune the dish' }))))
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(shown().title).toBe('Tune the antenna')
    void P.updateIssue(H, { title: 'Tune the antenna twice' })
    // so the server can refuse it as a change over Leo's
    expect(last('issues:update').args.expected).toEqual({
      title: print(trimmedForm, 'Tune the antenna'),
    })
  })

  it('sends nothing while the window’s read failed or runs again, and the editor keeps its draft', async () => {
    await load()
    await openFar()
    await fail('taskWindow:task')
    expect(P.detail?.state).toBe('failed')
    await expect(P.updateIssue(H, { priority: 'high' })).resolves.toBe(false)
    P.toggleIssueLabel(H, 'label-0')
    P.setIssueSubscribed(H, true)
    expect(P.moveIssue(H, 'bench')).toBeNull()
    await expect(P.archiveIssue(H, 'Gone')).resolves.toBe(false)
    expect(P.answerSaveWaits(H)).toBe(true)
    expect(P.refuseStaleEdit(H)).toBe(true)
    expect(window.showToast).toHaveBeenCalledWith(
      "Couldn't save yet. Saving is available once Qivo can check this task for changes.",
      'error',
    )
    P.retryTask()
    await turn()
    expect(P.detail?.state).toBe('retrying')
    await expect(P.updateIssue(H, { priority: 'high' })).resolves.toBe(false)
    expect(writes).toEqual([])
    // the next answer lets it save again
    await deliver('taskWindow:task', okAnswer())
    expect(P.answerSaveWaits(H)).toBe(false)
    void P.updateIssue(H, { priority: 'high' })
    expect(sent('issues:update')).toHaveLength(1)
  })

  it('sends nothing for a handle that is not the watched task’s', async () => {
    await load()
    await openFar()
    await expect(P.updateIssue('QN-41', { priority: 'high' })).resolves.toBe(false)
    P.toggleIssueLabel('QN-41', 'label-0')
    expect(P.moveIssue('QN-41', 'bench')).toBeNull()
    expect(P.editsFromAnswer('QN-41')).toBe(false)
    expect(writes).toEqual([])
  })

  it('treats a subtask list that is not whole as a group: no dates or hours, a status left to the server', async () => {
    await load(editsManuals)
    await openFar(
      okAnswer(far({ has_hidden_subtasks: true }), {
        subtasks: { rows: [short(task(FAR_KID, 42, { parent_id: FAR }))], complete: false },
      }),
    )
    expect(P.isGroup(shown())).toBe(true)
    const week = P.isoToWeek('2026-11-02')
    await expect(P.updateIssue(H, { start: week, end: week })).resolves.toBe(true)
    await expect(P.updateIssue(H, { remaining: 4 })).resolves.toBe(true)
    expect(writes).toEqual([])
    // a group's status goes, unpainted, and the server refuses it, as on
    // the held path
    void P.updateIssue(H, { status: 'done' })
    expect(last('issues:update').args.patch).toEqual({ status: 'done' })
    expect(shown().status).toBe('progress')
    last('issues:update').reject(
      new ConvexError({
        code: 'rule',
        message: 'A task with subtasks takes its status from them.',
      }),
    )
    await turn()
    expect(window.showToast).toHaveBeenCalled()
    expect(shown().status).toBe('progress')
    // the family is unknown, so nothing moves, archives or deletes
    expect(P.familyOf(shown())).toBeNull()
    expect(P.moveIssue(H, 'manuals')).toBeNull()
    await expect(P.archiveIssue(H, 'Gone')).resolves.toBe(false)
    await expect(P.deleteIssue(H, [], true)).resolves.toBe(false)
    expect(sent('issues:move')).toEqual([])
  })

  it('leaves a new assignee’s sight of the parent to the server, which refuses with its sentence', async () => {
    await load()
    const parent = task(PARENT, 39, { project_id: 'manuals', title: 'Write the manual' })
    await openFar(okAnswer(far({ parent_id: PARENT }), { parent: short(parent, 'viewer') }))
    // the store holds nobody but the signed-in person, so it cannot tell
    // whether Emil sees the parent: the write goes, painted
    const assigned = P.updateIssue(H, { assignee: EMIL })
    expect(last('issues:update').args.patch).toEqual({ assignee_id: EMIL })
    expect(shown().assignee).toBe(EMIL)
    last('issues:update').reject(new ConvexError({ code: 'rule', message: ASSIGNEE_SIGHT_RULE }))
    await expect(assigned).resolves.toBe(false)
    expect(window.showToast).toHaveBeenCalledWith(
      'A subtask can only be assigned to someone who can see every task above it. Change reverted.',
      'error',
    )
    expect(shown().assignee).not.toBe(EMIL)
    // a parent the answer leaves out is the server's to check
    await load()
    await openFar(okAnswer(far({ has_hidden_parent: true })))
    void P.updateIssue(H, { assignee: EMIL })
    expect(last('issues:update').args.patch).toEqual({ assignee_id: EMIL })
  })
})

describe('every copy of a task the window shows from its own answer', { timeout: 30_000 }, () => {
  /** The Overview's key for My view on the store's day (P.watchOverview). */
  const overviewKey = () =>
    JSON.stringify({
      scope: { kind: 'mine' },
      day: P.TODAY_ISO,
      week: P.isoFromDate(P.weekToDate(P.TODAY_WEEK)),
      week_starts: Array.from({ length: 53 }, (_, i) =>
        P.weekToDate(P.TODAY_WEEK - 52 + i).getTime(),
      ),
      week_end: P.weekToDate(P.TODAY_WEEK + 1).getTime(),
    })

  it('shows a Board write still waiting when the window opens on the task', async () => {
    await load()
    await openBoard([viewRow(far())])
    void P.updateIssue(H, { status: 'review' })
    expect(last('issues:update').args.expected).toEqual({ status: 'progress' })
    await openFar()
    expect(shown().status).toBe('review')
  })

  it('paints the Board card and an Overview row of the task with a window write', async () => {
    await load()
    await openBoard([viewRow(far({ paused: true }))])
    P.watchOverview(overviewKey(), 1, 0)
    await turn()
    const paused = open('overview:paused').at(-1)
    paused?.deliver({
      state: 'ok',
      rows: [viewRow(far({ paused: true }))],
      complete: true,
      next: null,
      end: 'op1~end',
    })
    await turn()
    await openFar(okAnswer(far({ paused: true })))
    void P.updateIssue(H, { title: 'Tune it' })
    expect(card()?.title).toBe('Tune it')
    expect(P.viewTask('overview:paused:2', FAR)?.title).toBe('Tune it')
    expect(shown().title).toBe('Tune it')
  })

  it('reshapes only the written task’s Board model among 300 open tasks of a sub-project', async () => {
    await load()
    // with QN-40 and the held QN-1, Work holds 300 open tasks
    const rows = Array.from({ length: 298 }, (_, i) =>
      viewRow(task(`fe000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 100 + i)),
    )
    await openBoard([...rows, viewRow(far())])
    await openFar()
    const before = rows.map((row) => card(row.id))
    void P.updateIssue(H, { priority: 'high' })
    expect(card()?.priority).toBe('high')
    expect(rows.map((row) => card(row.id))).toEqual(before)
    expect(rows.every((row, i) => card(row.id) === before[i])).toBe(true)
  })
})

describe('labels, the eye and Subscribers from the window’s answer', { timeout: 30_000 }, () => {
  it('puts a label on and takes it off from the answer’s labels, and the next answer ends the paint', async () => {
    await load()
    await openBoard([viewRow(far())])
    await openFar()
    P.toggleIssueLabel(H, 'label-0')
    expect(last('labels:toggle').args).toEqual({
      org_id: ORG,
      issue_id: FAR,
      label_id: 'label-0',
      on: true,
    })
    expect(shown().labels).toEqual(['label-0'])
    // the Board's row sends no labels, so its card is unsure under a filter
    // until the server accepts the toggle, which changes no Board row, so
    // the Board's answer does not come again for it
    expect([...P.ownUnsentEdits()]).toEqual([FAR])
    const views = P.updates.views.getSnapshot()
    await answerWith(last('labels:toggle'))
    expect(P.ownUnsentEdits().size).toBe(0)
    expect(P.updates.views.getSnapshot()).not.toBe(views)
    const on = okAnswer(far(), { labels: [{ issue_id: FAR, label_id: 'label-0' }] })
    await deliver('taskWindow:task', on)
    P.toggleIssueLabel(H, 'label-0')
    expect(last('labels:toggle').args).toMatchObject({ label_id: 'label-0', on: false })
    expect(shown().labels).toEqual([])
    await answerWith(last('labels:toggle'))
    await deliver('taskWindow:task', okAnswer())
    // someone else puts it on again: the paint is gone
    await deliver('taskWindow:task', on)
    expect(shown().labels).toEqual(['label-0'])
    expect(P.ownUnsentEdits().size).toBe(0)
  })

  it('refuses a 21st label before sending', async () => {
    await load()
    const labels = Array.from({ length: LIMITS.labels.max }, (_, i) => ({
      issue_id: FAR,
      label_id: `label-${i}`,
    }))
    await openFar(okAnswer(far(), { labels }))
    P.toggleIssueLabel(H, `label-${LIMITS.labels.max}`)
    expect(window.showToast).toHaveBeenCalledWith(limitSentence(LIMITS.labels), 'error')
    // taking one off still works
    P.toggleIssueLabel(H, 'label-0')
    expect(sent('labels:toggle').map((w) => w.args.on)).toEqual([false])
  })

  it('follows and unfollows with the answer’s organization and uuid', async () => {
    await load()
    await openFar()
    P.setIssueSubscribed(H, true)
    expect(last('issues:subscribe').args).toEqual({ org_id: ORG, issue_id: FAR })
    expect(shown().subscribed).toBe(true)
    await answerWith(last('issues:subscribe'))
    await deliver(
      'taskWindow:task',
      okAnswer(far(), { follow: { issue_id: FAR, profile_id: MIRA, created_at: SERVER } }),
    )
    P.setIssueSubscribed(H, false)
    expect(last('issues:unsubscribe').args).toEqual({ org_id: ORG, issue_id: FAR })
    expect(shown().subscribed).toBe(false)
    // the roster and a lead's add read the task's organization and uuid
    // from the window's model
    const roster = vi.fn()
    P.watchIssueSubscribers(shown(), roster, vi.fn())
    expect(one('issues:subscribers').args).toEqual({ org_id: ORG, issue_id: FAR })
    P.setIssueSubscriber(shown(), 'leo', true, vi.fn())
    expect(last('issues:setSubscriber').args).toEqual({
      org_id: ORG,
      issue_id: FAR,
      profile_id: 'leo',
      subscribed: true,
    })
  })

  it('follows with a guest seat in the task’s organization', async () => {
    const GUEST_ORG = 'org-guest'
    const SEAT = 'mira-guest'
    await load((next) => {
      next.orgs.push({ ...next.orgs[0], id: GUEST_ORG, name: 'Guest Labs', slug: 'guests' })
      next.profiles.push({
        ...next.profiles[0],
        id: SEAT,
        org_id: GUEST_ORG,
        org_role: 'guest',
      })
      next.myProfileIds = [MIRA, SEAT]
    })
    P.watchComments(FAR, GUEST_ORG)
    await turn()
    expect(one('taskWindow:task').args).toEqual({ org_id: GUEST_ORG, ref: FAR })
    await deliver('taskWindow:task', okAnswer(far({ org_id: GUEST_ORG }), { level: 'viewer' }))
    const id = shown().id
    P.setIssueSubscribed(id, true)
    expect(last('issues:subscribe').args).toEqual({ org_id: GUEST_ORG, issue_id: FAR })
    expect(shown().subscribed).toBe(true)
    expect(probe().rows().detail).toContain(SEAT)
  })
})

describe('files from the window’s own answer', { timeout: 30_000 }, () => {
  const attachment = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    issue_id: FAR,
    name: `${id}.pdf`,
    mime: 'application/pdf',
    size_bytes: 10,
    storage_id: `storage-${id}`,
    inline: false,
    created_at: AT,
    ...over,
  })
  /** Shows the sections, as the window's details column does, with the
      attachments answer `rows`. */
  async function showFiles(rows: ReturnType<typeof attachment>[]) {
    P.showSections({}, true)
    await turn()
    await deliver('taskWindow:attachments', {
      state: 'ok',
      rows,
      count: rows.length,
      complete: true,
    })
  }

  it('refuses an upload past 100 files counted from the whole attachments answer, before any bytes', async () => {
    await load()
    await openFar()
    await showFiles(
      Array.from({ length: LIMITS.attachments.max }, (_, i) => attachment(`att-${i}`)),
    )
    await expect(P.addAttachment(H, new File(['bytes'], 'notes.txt'))).resolves.toBeNull()
    expect(window.showToast).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't upload"),
      'error',
    )
    expect(sent('files:uploadUrl')).toEqual([])
  })

  it('refuses a file past its project’s size limit, and uploads one within it to the answer’s task', async () => {
    await load()
    await openFar()
    expect(P.attachmentLimit(H)).toBe(1024 * 1024)
    const big = new File([new Uint8Array(2 * 1024 * 1024)], 'big.bin')
    await expect(P.addAttachment(H, big)).resolves.toBeNull()
    expect(sent('files:uploadUrl')).toEqual([])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ storageId: 'st-1' }) })),
    )
    const added = P.addAttachment(H, new File(['bytes'], 'photo.png', { type: 'image/png' }), {
      inline: true,
    })
    await turn()
    // the size and name of the file the POST sends
    expect(last('files:uploadUrl').args).toEqual({
      org_id: ORG,
      issue_id: FAR,
      size: 5,
      name: 'photo.png',
    })
    await answerWith(last('files:uploadUrl'), 'https://convex.example/upload')
    await turn()
    expect(last('files:attach').args).toMatchObject({
      org_id: ORG,
      issue_id: FAR,
      storage_id: 'st-1',
      inline: true,
    })
    const attId = last('files:attach').args.id
    await answerWith(last('files:attach'), { attachment: attachment(String(attId)) })
    await expect(added).resolves.toBe(attId)
    // the image goes into the description the window saves from its answer
    void P.updateIssue(H, { description: `Gain ![photo](att:${attId})` })
    expect(last('issues:update').args.patch).toEqual({
      description: `Gain ![photo](att:${attId})`,
    })
  })

  /** Holds the image re-encoding of the next uploads until the answer is
      called. */
  const holdCompression = () => {
    let release = () => {}
    compression.held = new Promise<void>((resolve) => {
      release = resolve
    })
    return release
  }
  const uploaded = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ storageId: 'st-1' }) })),
    )

  it('sends a file to the task its handle named when the upload began, though the handle moves to another task meanwhile', async () => {
    const BETA = 'org-beta'
    await load((next) => {
      // Mira also holds a seat in Beta, which holds its own QN-40
      next.orgs.push({ ...next.orgs[0], id: BETA, name: 'Beta', slug: 'beta' })
      next.profiles.push({ ...next.profiles[0], id: 'mira-beta', org_id: BETA, org_role: 'user' })
      next.myProfileIds.push('mira-beta')
      next.projects.push(
        { ...next.projects[0], id: 'beta-plan', org_id: BETA, key: 'BP', lead_id: 'mira-beta' },
        {
          ...next.projects[1],
          id: 'beta-work',
          org_id: BETA,
          key: 'BW',
          parent_id: 'beta-plan',
        },
      )
      next.issues.push(task('beta-40', 40, { org_id: BETA, project_id: 'beta-work' }))
    })
    await openFar()
    uploaded()
    const release = holdCompression()
    const added = P.addAttachment(H, new File(['bytes'], 'photo.png', { type: 'image/png' }), {
      inline: true,
    })
    // Mira's seat here turns guest while the image re-encodes, so Beta is
    // her home now, where QN-40 names Beta's own task
    for (const p of snap.profiles) if (p.id === MIRA) p.org_role = 'guest'
    publishWorkspace()
    await turn()
    expect(P.homeOrg).toBe(BETA)
    expect(P.issueById[H]?.uuid).toBe('beta-40')
    release()
    await turn()
    expect(sent('files:uploadUrl').map((w) => w.args)).toEqual([
      { org_id: ORG, issue_id: FAR, size: 5, name: 'photo.png' },
    ])
    await answerWith(last('files:uploadUrl'), 'https://convex.example/upload')
    await turn()
    expect(last('files:attach').args).toMatchObject({ org_id: ORG, issue_id: FAR })
    const attId = last('files:attach').args.id
    await answerWith(last('files:attach'), { attachment: attachment(String(attId)) })
    await expect(added).resolves.toBe(attId)
  })

  it('says an upload stopped once the window no longer shows its task, and sends no bytes', async () => {
    await load()
    await openFar()
    const release = holdCompression()
    const image = new File(['bytes'], 'photo.png', { type: 'image/png' })
    const added = P.addAttachment(FAR, image)
    // the window moves to another task while the file re-encodes
    P.watchComments('task-a', ORG)
    release()
    await expect(added).resolves.toBeNull()
    const stopped =
      'Couldn\'t upload "photo.png". The upload stopped because the window no longer shows its task.'
    expect(window.showToast).toHaveBeenCalledWith(stopped, 'error')
    // and a file still queued for it says the same when its turn comes
    window.showToast = vi.fn()
    await expect(P.addAttachment(FAR, image)).resolves.toBeNull()
    expect(window.showToast).toHaveBeenCalledWith(stopped, 'error')
    expect(sent('files:uploadUrl')).toEqual([])
  })

  it('says why an upload waits while the window’s read failed, and sends no bytes', async () => {
    await load()
    await openFar()
    await fail('taskWindow:task')
    const image = new File(['bytes'], 'photo.png', { type: 'image/png' })
    await expect(P.addAttachment(H, image, { inline: true })).resolves.toBeNull()
    expect(window.showToast).toHaveBeenCalledWith(
      "Couldn't save yet. Saving is available once Qivo can check this task for changes.",
      'error',
    )
    expect(sent('files:uploadUrl')).toEqual([])
  })

  it('removes a file only the attachments answer holds with no paint, until that answer drops it', async () => {
    await load()
    await openFar()
    await showFiles([attachment('att-f')])
    expect(P.sections?.attachments.rows.map((r) => [r.id, r.held])).toEqual([['att-f', false]])
    const removed = P.removeAttachment('att-f')
    expect(last('files:removeAttachment').args).toEqual({ org_id: ORG, id: 'att-f' })
    expect(P.sections?.attachments.rows.map((r) => r.id)).toEqual(['att-f'])
    // Convex delivers the answer without it before the write resolves
    await deliver('taskWindow:attachments', { state: 'ok', rows: [], count: 0, complete: true })
    expect(P.sections?.attachments.rows).toEqual([])
    await answerWith(last('files:removeAttachment'))
    await expect(removed).resolves.toBe(true)
  })
})

describe('Move, Archive and delete from the window’s own answer', { timeout: 30_000 }, () => {
  const kid = (id: string, num: number, over: Partial<Task> = {}) =>
    task(id, num, { parent_id: FAR, title: `Subtask ${num}`, ...over })
  const family = (extra: Record<string, unknown> = {}) =>
    okAnswer(far({ parent_id: PARENT }), {
      parent: short(task(PARENT, 39, { title: 'Build the mast' })),
      subtasks: { rows: [short(kid(FAR_KID, 42))], complete: true },
      ...extra,
    })

  it('moves the task with the subtasks it carries, sending the project and the parent pair it showed', async () => {
    await load(editsManuals)
    await openBoard([viewRow(far({ parent_id: PARENT })), viewRow(kid(FAR_KID, 42))])
    await openFar(family())
    P.showSections({}, true)
    await turn()
    // another top-level project: the parent stays behind, the subtask comes
    expect(P.moveIssue(H, 'manuals')).toBe(H)
    expect(last('issues:move').args).toEqual({
      org_id: ORG,
      id: FAR,
      project_id: 'manuals',
      detach_parent: true,
      expected: { project_id: 'work', parent_id: PARENT, has_hidden_parent: false },
    })
    expect(shown().project).toBe('manuals')
    expect(shown().parent).toBeNull()
    expect(P.sections?.subtasks.rows.map((r) => r.project)).toEqual(['manuals'])
    expect(card()?.project).toBe('manuals')
    expect(card(FAR_KID)?.project).toBe('manuals')
    // within its top-level project nothing else moves
    await load(editsManuals)
    await openFar(family())
    P.moveIssue(H, 'bench')
    expect(last('issues:move').args).toEqual({
      org_id: ORG,
      id: FAR,
      project_id: 'bench',
      expected: { project_id: 'work' },
    })
    // a hidden parent counts as in the task's own top-level project, and
    // the pair says only that there is one
    await load(editsManuals)
    await openFar(okAnswer(far({ has_hidden_parent: true })))
    P.moveIssue(H, 'manuals')
    expect(last('issues:move').args).toMatchObject({
      detach_parent: true,
      expected: { project_id: 'work', parent_id: null, has_hidden_parent: true },
    })
  })

  it('moves only into a target the project cache answered, never one it only seeded', async () => {
    await load()
    await openBoard([viewRow(far()), viewRow(kid(FAR_KID, 42))])
    await openFar(family())
    P.showSections({}, true)
    await turn()
    // a target a targets row seeded but the cache has not answered
    P.seedProjects([{ id: 'tools', org_id: ORG, name: 'Tools', num: 9, parent_id: 'plan' }])
    expect(P.project('tools')).toBeDefined()
    expect(P.projectState('tools')).not.toBe('ok')
    expect(P.moveIssue(H, 'tools')).toBeNull()
    expect(sent('issues:move')).toEqual([])
    // an answered one moves
    expect(P.moveIssue(H, 'bench')).toBe(H)
    expect(sent('issues:move')).toHaveLength(1)
  })

  it('deletes with the chosen subtasks’ uuids from the answer and archives, painting nothing before the server answers', async () => {
    await load()
    await openFar(
      family({
        subtasks: {
          rows: [
            short(kid(FAR_KID, 42)),
            short(kid(FAR_KID_2, 43, { project_id: 'manuals' }), 'viewer'),
          ],
          complete: true,
        },
      }),
    )
    const tasks = P.familyOf(shown())
    expect(tasks && P.deletePlan(H, tasks).rows.map((r) => [r.task.key, r.deletable])).toEqual([
      ['QN-42', true],
      ['QN-43', false],
    ])
    const deleted = P.deleteIssue(H, ['QN-42', 'QN-43'], true, 'Done with it')
    expect(last('issues:deleteDeep').args).toEqual({
      org_id: ORG,
      id: FAR,
      subtask_ids: [FAR_KID, FAR_KID_2],
      reason: 'Done with it',
    })
    expect(shown().title).toBe('Tune the antenna')
    await answerWith(last('issues:deleteDeep'))
    await expect(deleted).resolves.toBe(true)
    const archived = P.archiveIssue(H, 'Not needed')
    await turn()
    expect(last('issues:archive').args).toEqual({ org_id: ORG, id: FAR, reason: 'Not needed' })
    await answerWith(last('issues:archive'), { archived: true })
    await expect(archived).resolves.toBe(true)
  })
})
