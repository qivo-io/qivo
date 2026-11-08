import { type FunctionReference, getFunctionName, makeFunctionReference } from 'convex/server'
import { ConvexError, type Value } from 'convex/values'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { idWindows } from '../../convex/lib/idWindows'
import type { LiveQueries, LiveTransition } from '../lib/liveQueries'
import { createLiveParts, type PartsReport, STALL } from './liveParts'

/* The root part's arguments, none (convex/workspace.ts root). */
const ROOT_ARGS = {}

/* The registry over a scripted transport: the test plays the server, sets
   what each part answers and sends transitions naming the parts that
   changed. */

const ORG = 'org-1'
// 300 tasks: two task windows of WINDOW_ROWS.tasks, split at the middle of
// the id space
const ROOT = {
  auth_user_id: 'a',
  myProfileIds: ['me'],
  orgs: [{ id: ORG, name: 'Org', next_issue_num: 300, next_project_num: 1 }],
  // the caller's own rows, which the root carries (convex/lib/workspaceParts.ts readRoot)
  profiles: [],
  teamMembers: [],
  teams: [],
  create: 'now',
}
// the one project window of a small organization
const PROJECTS = { org_id: ORG, from: '', to: null }
// a projects window's answer with one project, as a change elsewhere sends it
const changedProjects = (id: string) =>
  ok({ projects: [{ id, org_id: ORG }], access: [], teamAccess: [] })
const LEFT = { from: '', to: '80000000' }
const RIGHT = { from: '80000000', to: null }
const ok = (rows: Record<string, unknown[]>) => ({ state: 'ok', ...rows })
const task = (id: string) => ({ id, org_id: ORG, title: id })
const EMPTY = {
  'workspace:projects': ok({ projects: [], access: [], teamAccess: [] }),
}
const tasksPart = (ids: string[], extra = {}) => ({
  ...ok({
    issues: ids.map(task),
    links: [],
    issueLabels: [],
    attachments: [],
    issueSubs: [],
    orgLoad: [],
  }),
  ...extra,
})

function scripted() {
  const answers = new Map<string, { value?: unknown; error?: unknown }>()
  const watched = new Map<string, number>()
  // every watch and stop, in order
  const log: string[] = []
  // tokens whose failed run Convex keeps until they are watched again
  const failedRun = new Set<string>()
  const handlers = new Set<(t: LiveTransition) => void>()
  const keyOf = (name: string, args: Record<string, unknown>) => `${name}${JSON.stringify(args)}`
  let at = 1
  let connection = 1
  const live: LiveQueries = {
    watch(ref: FunctionReference<'query'>, args: Record<string, Value>) {
      const token = keyOf(getFunctionName(ref), args)
      watched.set(token, (watched.get(token) ?? 0) + 1)
      log.push(`watch ${token}`)
      failedRun.delete(token)
      return {
        token,
        joined: false,
        stop: () => {
          log.push(`stop ${token}`)
          const n = (watched.get(token) ?? 1) - 1
          if (n) watched.set(token, n)
          else watched.delete(token)
        },
      }
    },
    read(token) {
      const a = answers.get(token)
      if (a?.error !== undefined) {
        failedRun.add(token)
        throw a.error
      }
      if (failedRun.has(token)) throw new Error('the failed run stays')
      return a?.value
    },
    onTransition(fn) {
      handlers.add(fn)
      return () => handlers.delete(fn)
    },
    query: (async () => null) as LiveQueries['query'],
  }
  return {
    live,
    watched,
    log,
    /** Sets the answer of part `name` with `args`. */
    set(name: string, args: Record<string, unknown>, answer: { value?: unknown; error?: unknown }) {
      answers.set(keyOf(name, args), answer)
    },
    /** Sends a transition naming the watched parts given, or all watched. */
    send(tokens = [...watched.keys()]) {
      at++
      for (const fn of handlers) fn({ tokens: new Set(tokens), at, connection })
    },
    reconnect() {
      connection++
    },
    keyOf,
  }
}

/* A server holding tasks a and b in the first task window and c in the
   second. */
function serve(s: ReturnType<typeof scripted>) {
  s.set('workspace:root', ROOT_ARGS, { value: ROOT })
  for (const [name, value] of Object.entries(EMPTY))
    s.set(name, { org_id: ORG, from: '', to: null }, { value })
  s.set('workspace:tasks', { org_id: ORG, ...LEFT }, { value: tasksPart(['a', 'b']) })
  s.set('workspace:tasks', { org_id: ORG, ...RIGHT }, { value: tasksPart(['c']) })
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// the task window's side queries
const THREAD = makeFunctionReference<'query'>('snapshot:threadComments')
const HISTORY = makeFunctionReference<'query'>('snapshot:threadHistory')
const TASK = makeFunctionReference<'query'>('taskWindow:task')
const LINKS = makeFunctionReference<'query'>('taskWindow:links')
const ATTACHMENTS = makeFunctionReference<'query'>('taskWindow:attachments')

/* A registry that asked for every task from the start, with every part
   answered. */
async function started() {
  const s = scripted()
  serve(s)
  const reports: PartsReport[] = []
  const parts = createLiveParts(
    s.live,
    (r) => reports.push(r),
    () => true,
    { ask: true },
  )
  s.send()
  await tick()
  s.send()
  const last = () => reports.at(-1)?.workspace
  const ids = () => {
    const w = last()
    return w?.state === 'complete' ? w.value?.issues.map((i) => i.id) : null
  }
  return { s, parts, reports, last, ids }
}

afterEach(() => {
  vi.useRealTimers()
  STALL.ms = 60_000
})

describe('the live parts registry', () => {
  it('reports the workspace complete only once every part answered, joined in window order', async () => {
    const s = scripted()
    serve(s)
    const reports: PartsReport[] = []
    createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
      { ask: true },
    )
    s.send()
    // the root answered, the parts not yet
    expect(reports.at(-1)?.workspace.state).toBe('held')
    await tick()
    s.send()
    const w = reports.at(-1)?.workspace
    expect(w?.state === 'complete' && w.value?.issues.map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(w?.state === 'complete' && w.tasks).toBe('all')
  })

  it("joins a projects part without milestones, and ignores the milestones an earlier backend's part still sends", async () => {
    const { s, last } = await started()
    const whole = { org_id: ORG, from: '', to: null }
    const project = { id: 'p1', org_id: ORG, name: 'Plan', type: 'meta' }
    const milestone = { id: 'm1', project_id: 'p1', name: 'Launch', week: '2026-11-02' }
    s.set('workspace:projects', whole, {
      value: ok({ projects: [project], access: [], teamAccess: [], milestones: [milestone] }),
    })
    s.send([s.keyOf('workspace:projects', whole)])
    const w = last()
    if (w?.state !== 'complete' || !w.value) throw new Error('not complete')
    expect(w.value.projects.map((p) => p.id)).toEqual(['p1'])
    expect(w.value).not.toHaveProperty('milestones')
    expect(JSON.stringify(w.value)).not.toContain('Launch')
  })

  it('joins a part whose long lists came in chunks, in order', async () => {
    const { s, ids } = await started()
    const first = { org_id: ORG, ...LEFT }
    s.set('workspace:tasks', first, {
      value: { ...tasksPart(['a']), more: { issues: [[task('a2'), task('a3')], [task('a4')]] } },
    })
    s.send([s.keyOf('workspace:tasks', first)])
    expect(ids()).toEqual(['a', 'a2', 'a3', 'a4', 'c'])
  })

  it('adopts the halves of a split window only together, with no task missing or doubled', async () => {
    const { s, ids, last } = await started()
    const first = { org_id: ORG, ...LEFT }
    s.set('workspace:tasks', first, { value: tasksPart(['a', 'b'], { split: true }) })
    s.send([s.keyOf('workspace:tasks', first)])
    // the window keeps serving while its halves load
    expect(ids()).toEqual(['a', 'b', 'c'])
    const left = { org_id: ORG, from: '', to: '40000000' }
    const right = { org_id: ORG, from: '40000000', to: '80000000' }
    s.set('workspace:tasks', left, { value: tasksPart(['a']) })
    s.send([s.keyOf('workspace:tasks', left)])
    expect(ids()).toEqual(['a', 'b', 'c'])
    s.set('workspace:tasks', right, { value: tasksPart(['b', 'b2']) })
    s.send([s.keyOf('workspace:tasks', right)])
    expect(ids()).toEqual(['a', 'b', 'b2', 'c'])
    expect(last()?.state === 'complete' && last()).toMatchObject({ changed: true })
    // the split window gave way to its halves
    expect(s.watched.has(s.keyOf('workspace:tasks', first))).toBe(false)
  })

  it('holds the workspace while an overflowing window has no halves yet', async () => {
    const { s, last, ids } = await started()
    const first = { org_id: ORG, ...LEFT }
    s.set('workspace:tasks', first, { value: { state: 'overflow' } })
    s.send([s.keyOf('workspace:tasks', first)])
    expect(last()?.state).toBe('held')
    s.set('workspace:tasks', { org_id: ORG, from: '', to: '40000000' }, { value: tasksPart(['a']) })
    s.set(
      'workspace:tasks',
      { org_id: ORG, from: '40000000', to: '80000000' },
      { value: tasksPart(['b']) },
    )
    s.send()
    expect(ids()).toEqual(['a', 'b', 'c'])
  })

  it('cuts an overflowing window into the pieces its answer names, in one round', async () => {
    const { s, last, ids } = await started()
    const first = { org_id: ORG, ...LEFT }
    s.set('workspace:tasks', first, { value: { state: 'overflow', pieces: 4 } })
    s.send([s.keyOf('workspace:tasks', first)])
    const pieces = [
      ['', '20000000'],
      ['20000000', '40000000'],
      ['40000000', '60000000'],
      ['60000000', '80000000'],
    ].map(([from, to]) => ({ org_id: ORG, from, to }))
    // every piece is watched at once, and none of the halves
    for (const piece of pieces) expect(s.watched.has(s.keyOf('workspace:tasks', piece))).toBe(true)
    expect(
      s.watched.has(s.keyOf('workspace:tasks', { org_id: ORG, from: '', to: '40000000' })),
    ).toBe(false)
    for (const [i, piece] of pieces.entries())
      if (i < 3) s.set('workspace:tasks', piece, { value: tasksPart([`p${i}`]) })
    s.send()
    expect(last()?.state).toBe('held')
    s.set('workspace:tasks', pieces[3], { value: tasksPart(['p3']) })
    s.send()
    expect(ids()).toEqual(['p0', 'p1', 'p2', 'p3', 'c'])
    expect(s.watched.has(s.keyOf('workspace:tasks', first))).toBe(false)
  })

  it('after a reconnect, holds the workspace until every part arrived again', async () => {
    const { s, last } = await started()
    s.reconnect()
    s.send([s.keyOf('workspace:root', ROOT_ARGS)])
    expect(last()?.state).toBe('held')
    s.send()
    expect(last()?.state).toBe('complete')
  })

  it('names the connection of each report, so news after a reconnect is told from news before', async () => {
    const { s, parts, reports } = await started()
    expect(reports.at(-1)?.connection).toBe(1)
    parts.watchSide('task', TASK, { ref: 't' })
    const side = s.keyOf('taskWindow:task', { ref: 't' })
    s.set('taskWindow:task', { ref: 't' }, { value: { state: 'ok' } })
    s.send([side])
    expect(reports.at(-1)).toMatchObject({
      connection: 1,
      sides: { task: { value: { state: 'ok' } } },
    })
    // the socket reconnects: a transition that brings the root alone names
    // the new connection and no side news, so the side's answer from before
    // is not the newest connection's
    s.reconnect()
    s.send([s.keyOf('workspace:root', ROOT_ARGS)])
    expect(reports.at(-1)?.connection).toBe(2)
    expect(reports.at(-1)?.sides).toBeUndefined()
    s.send([side])
    expect(reports.at(-1)).toMatchObject({
      connection: 2,
      sides: { task: { value: { state: 'ok' } } },
    })
  })

  it('fails on a failed or refusing part, and Retry runs only that part again', async () => {
    const { s, parts, last } = await started()
    const projectsKey = s.keyOf('workspace:projects', PROJECTS)
    s.set('workspace:projects', PROJECTS, { error: new Error('boom') })
    s.send([projectsKey])
    expect(last()).toMatchObject({ state: 'failed' })
    s.set('workspace:projects', PROJECTS, { value: EMPTY['workspace:projects'] })
    // the failed run stays until the part is watched again
    s.send([projectsKey])
    expect(last()).toMatchObject({ state: 'failed' })
    s.log.length = 0
    expect(parts.retry()).toBe(true)
    expect(s.log).toEqual([`stop ${projectsKey}`, `watch ${projectsKey}`])
    s.send([projectsKey])
    expect(last()?.state).toBe('complete')
    s.set('workspace:projects', PROJECTS, { value: { state: 'refused', message: 'Too much.' } })
    s.send([projectsKey])
    const failed = last()
    expect(failed?.state === 'failed' && (failed.error as { data: unknown }).data).toEqual({
      code: 'rule',
      message: 'Too much.',
    })
    s.log.length = 0
    expect(parts.retry()).toBe(true)
    expect(s.log).toEqual([`stop ${projectsKey}`, `watch ${projectsKey}`])
    s.set('workspace:projects', PROJECTS, { value: EMPTY['workspace:projects'] })
    s.send([projectsKey])
    expect(last()?.state).toBe('complete')
    // nothing failed, nothing to run again
    expect(parts.retry()).toBe(false)
  })

  it('a window that fails after asking to be cut gives way to its halves, and a half that fails waits while its window shows', async () => {
    const { s, parts, last, ids } = await started()
    const first = { org_id: ORG, ...LEFT }
    const left = { org_id: ORG, from: '', to: '40000000' }
    const right = { org_id: ORG, from: '40000000', to: '80000000' }
    s.set('workspace:tasks', first, { value: tasksPart(['a', 'b'], { split: true }) })
    s.send([s.keyOf('workspace:tasks', first)])
    // a half fails while its window still shows every row
    s.set('workspace:tasks', left, { error: new Error('half failed') })
    s.send([s.keyOf('workspace:tasks', left)])
    expect(ids()).toEqual(['a', 'b', 'c'])
    // then the window fails too: only the failed half holds it up
    s.set('workspace:tasks', first, { error: new Error('grown too far') })
    s.send([s.keyOf('workspace:tasks', first)])
    expect(last()).toMatchObject({ state: 'failed' })
    s.log.length = 0
    expect(parts.retry()).toBe(true)
    expect(s.log).toEqual([
      `stop ${s.keyOf('workspace:tasks', left)}`,
      `watch ${s.keyOf('workspace:tasks', left)}`,
    ])
    s.set('workspace:tasks', left, { value: tasksPart(['a']) })
    s.set('workspace:tasks', right, { value: tasksPart(['b']) })
    s.send([s.keyOf('workspace:tasks', left), s.keyOf('workspace:tasks', right)])
    expect(ids()).toEqual(['a', 'b', 'c'])
    expect(s.watched.has(s.keyOf('workspace:tasks', first))).toBe(false)
  })

  it('reports no seat, and drops a seat that goes without holding the workspace', async () => {
    const { s, last, ids } = await started()
    s.set('workspace:root', ROOT_ARGS, { value: { ...ROOT, orgs: [] } })
    s.send([s.keyOf('workspace:root', ROOT_ARGS)])
    expect(ids()).toEqual([])
    expect([...s.watched.keys()].every((key) => !key.includes(ORG))).toBe(true)
    s.set('workspace:root', ROOT_ARGS, { value: null })
    s.send([s.keyOf('workspace:root', ROOT_ARGS)])
    expect(last()).toMatchObject({ state: 'complete', value: null })
  })

  it('a failed side query rides along without failing or holding the workspace', async () => {
    const { s, parts, reports, last } = await started()
    parts.watchSide('thread', THREAD, { issue_id: 't' })
    const side = s.keyOf('snapshot:threadComments', { issue_id: 't' })
    s.set('snapshot:threadComments', { issue_id: 't' }, { error: new Error('thread failed') })
    s.send([side])
    expect(last()?.state).toBe('complete')
    expect(reports.at(-1)?.sides).toEqual({ thread: { error: expect.any(Error) } })
  })

  it('reports each side query on its own, and one failing holds neither the workspace nor the other', async () => {
    const { s, parts, reports, last } = await started()
    parts.watchSide('thread', THREAD, { issue_id: 't' })
    parts.watchSide('history', HISTORY, { issue_id: 't' })
    const thread = s.keyOf('snapshot:threadComments', { issue_id: 't' })
    const history = s.keyOf('snapshot:threadHistory', { issue_id: 't' })
    s.set('snapshot:threadComments', { issue_id: 't' }, { value: { comments: ['c'] } })
    s.send([thread])
    expect(reports.at(-1)?.sides).toEqual({ thread: { value: { comments: ['c'] } } })
    s.set('snapshot:threadHistory', { issue_id: 't' }, { error: new Error('history failed') })
    s.send([history])
    expect(reports.at(-1)?.sides).toEqual({ history: { error: expect.any(Error) } })
    // Convex keeps a failed run until the side is watched afresh, as a retry
    // does, and then both in one transition, beside a workspace change,
    // report once
    parts.watchSide('history', HISTORY, { issue_id: 't' })
    const count = reports.length
    s.set('snapshot:threadComments', { issue_id: 't' }, { value: { comments: ['c', 'd'] } })
    s.set('snapshot:threadHistory', { issue_id: 't' }, { value: { events: ['e'] } })
    s.set('workspace:tasks', { org_id: ORG, ...LEFT }, { value: tasksPart(['a']) })
    s.send([thread, history, s.keyOf('workspace:tasks', { org_id: ORG, ...LEFT })])
    expect(reports).toHaveLength(count + 1)
    expect(reports.at(-1)?.sides).toEqual({
      thread: { value: { comments: ['c', 'd'] } },
      history: { value: { events: ['e'] } },
    })
    expect(last()).toMatchObject({ state: 'complete', changed: true })
    // a workspace transition alone tells of no side
    s.send([s.keyOf('workspace:projects', PROJECTS)])
    expect(reports.at(-1)?.sides).toBeUndefined()
  })

  it('replaces or stops one side query and keeps the other, and stop() drops both', async () => {
    const { s, parts } = await started()
    parts.watchSide('thread', THREAD, { issue_id: 't' })
    parts.watchSide('history', HISTORY, { issue_id: 't' })
    const history = s.keyOf('snapshot:threadHistory', { issue_id: 't' })
    parts.watchSide('thread', THREAD, { issue_id: 'u' })
    expect(s.watched.has(s.keyOf('snapshot:threadComments', { issue_id: 't' }))).toBe(false)
    expect(s.watched.has(s.keyOf('snapshot:threadComments', { issue_id: 'u' }))).toBe(true)
    expect(s.watched.has(history)).toBe(true)
    parts.stopSide('history')
    expect(s.watched.has(history)).toBe(false)
    expect(s.watched.has(s.keyOf('snapshot:threadComments', { issue_id: 'u' }))).toBe(true)
    parts.watchSide('history', HISTORY, { issue_id: 'u' })
    parts.stop()
    expect([...s.watched.keys()].filter((key) => key.startsWith('snapshot:'))).toEqual([])
  })

  it('reports all five side queries on their own, and stops one or all of them', async () => {
    const { s, parts, reports, last } = await started()
    const sides = [
      ['thread', THREAD, 'snapshot:threadComments', { issue_id: 't' }],
      ['history', HISTORY, 'snapshot:threadHistory', { issue_id: 't' }],
      ['task', TASK, 'taskWindow:task', { ref: 't' }],
      ['links', LINKS, 'taskWindow:links', { issue_id: 't' }],
      ['attachments', ATTACHMENTS, 'taskWindow:attachments', { issue_id: 't' }],
    ] as const
    for (const [side, ref, , args] of sides) parts.watchSide(side, ref, args)
    const key = (at: number) => s.keyOf(sides[at][2], sides[at][3])
    // each answers alone
    for (const [at, [side, , name, args]] of sides.entries()) {
      s.set(name, args, { value: { side } })
      s.send([key(at)])
      expect(reports.at(-1)?.sides).toEqual({ [side]: { value: { side } } })
    }
    // one failing holds neither the workspace nor another side, in one report
    const count = reports.length
    s.set('taskWindow:links', { issue_id: 't' }, { error: new Error('links failed') })
    s.set('taskWindow:task', { ref: 't' }, { value: { side: 'task', again: true } })
    s.set('workspace:tasks', { org_id: ORG, ...LEFT }, { value: tasksPart(['a']) })
    s.send([key(3), key(2), s.keyOf('workspace:tasks', { org_id: ORG, ...LEFT })])
    expect(reports).toHaveLength(count + 1)
    expect(reports.at(-1)?.sides).toEqual({
      links: { error: expect.any(Error) },
      task: { value: { side: 'task', again: true } },
    })
    expect(last()).toMatchObject({ state: 'complete', changed: true })
    // stopping one keeps the other four
    parts.stopSide('attachments')
    expect(s.watched.has(key(4))).toBe(false)
    for (const at of [0, 1, 2, 3]) expect(s.watched.has(key(at))).toBe(true)
    parts.stop()
    for (const at of [0, 1, 2, 3]) expect(s.watched.has(key(at))).toBe(false)
  })

  it('hands a side query that another side watches with the same arguments over, with its answer', async () => {
    const { s, parts, reports } = await started()
    const args = { org_id: ORG, ref: 't' }
    const key = s.keyOf('taskWindow:task', args)
    parts.watchSide('reference', TASK, args)
    s.set('taskWindow:task', args, { value: { state: 'ok' } })
    s.send([key])
    expect(reports.at(-1)?.sides).toEqual({ reference: { value: { state: 'ok' } } })
    s.log.length = 0
    // Convex keeps one subscription for both: the task side takes it over,
    // with the answer that arrived, and watches nothing again
    expect(parts.watchSide('task', TASK, args)).toEqual({ value: { state: 'ok' } })
    expect(s.log).toEqual([])
    expect(parts.sideArgs('reference')).toBeUndefined()
    expect(parts.sideArgs('task')).toEqual(args)
    // and hears that subscription's next answer as its own
    s.set('taskWindow:task', args, { value: { state: 'unavailable' } })
    s.send([key])
    expect(reports.at(-1)?.sides).toEqual({ task: { value: { state: 'unavailable' } } })
    // an answer from before a reconnect is not handed over as current
    parts.watchSide('reference', TASK, { org_id: ORG, ref: 'u' })
    const other = s.keyOf('taskWindow:task', { org_id: ORG, ref: 'u' })
    s.set('taskWindow:task', { org_id: ORG, ref: 'u' }, { value: { state: 'ok' } })
    s.send([other])
    s.reconnect()
    s.send([s.keyOf('workspace:root', ROOT_ARGS)])
    expect(parts.watchSide('task', TASK, { org_id: ORG, ref: 'u' })).toBeUndefined()
    // a side with other arguments watches anew
    expect(parts.watchSide('task', TASK, { org_id: ORG, ref: 'v' })).toBeUndefined()
    expect(s.watched.has(s.keyOf('taskWindow:task', { org_id: ORG, ref: 'v' }))).toBe(true)
    expect(s.watched.has(other)).toBe(false)
  })

  it("never hands the task side's subscription to a reference read with the same arguments", async () => {
    const { s, parts } = await started()
    const args = { org_id: ORG, ref: 't' }
    const key = s.keyOf('taskWindow:task', args)
    parts.watchSide('task', TASK, args)
    s.set('taskWindow:task', args, { value: { state: 'ok' } })
    s.send([key])
    s.log.length = 0
    // a reference read with the task side's arguments, which the store
    // never starts (planner.ts runRefRead), takes nothing from the task
    // side, which keeps its subscription
    expect(parts.watchSide('reference', TASK, args)).toBeUndefined()
    expect(parts.sideArgs('task')).toEqual(args)
    expect(parts.sideArgs('reference')).toEqual(args)
    expect(s.log).toEqual([`watch ${key}`])
  })

  it('fails a workspace that stays incomplete with no part answering while online, and waits while offline', async () => {
    vi.useFakeTimers()
    STALL.ms = 1000
    const s = scripted()
    serve(s)
    s.set('workspace:projects', PROJECTS, {})
    let online = false
    const reports: PartsReport[] = []
    createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => online,
    )
    s.send()
    await vi.advanceTimersByTimeAsync(0)
    s.send()
    expect(reports.at(-1)?.workspace.state).toBe('held')
    await vi.advanceTimersByTimeAsync(5000)
    expect(reports.at(-1)?.workspace.state).toBe('held')
    online = true
    // a part answering starts the wait over
    await vi.advanceTimersByTimeAsync(600)
    s.send([s.keyOf('workspace:root', ROOT_ARGS)])
    await vi.advanceTimersByTimeAsync(600)
    expect(reports.at(-1)?.workspace.state).toBe('held')
    await vi.advanceTimersByTimeAsync(400)
    expect(reports.at(-1)?.workspace.state).toBe('failed')
  })

  it('fails a workspace whose root never answers while online', async () => {
    vi.useFakeTimers()
    STALL.ms = 1000
    const s = scripted()
    const reports: PartsReport[] = []
    createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
    )
    await vi.advanceTimersByTimeAsync(999)
    expect(reports).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(reports.at(-1)?.workspace.state).toBe('failed')
  })

  it('the side query answering does not start the wait over', async () => {
    vi.useFakeTimers()
    STALL.ms = 1000
    const s = scripted()
    serve(s)
    s.set('workspace:projects', PROJECTS, {})
    const reports: PartsReport[] = []
    const parts = createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
    )
    parts.watchSide('thread', THREAD, { issue_id: 't' })
    s.send()
    await vi.advanceTimersByTimeAsync(0)
    s.send()
    expect(reports.at(-1)?.workspace.state).toBe('held')
    const side = s.keyOf('snapshot:threadComments', { issue_id: 't' })
    for (let i = 0; i < 4; i++) {
      s.set('snapshot:threadComments', { issue_id: 't' }, { value: { comments: [i] } })
      s.send([side])
      await vi.advanceTimersByTimeAsync(400)
    }
    expect(reports.some((r) => r.workspace.state === 'failed')).toBe(true)
  })
})

/* An organization of 12,800 task numbers: 64 task windows. Window i holds
   task t<i>. */
const BIG = { ...ROOT, orgs: [{ ...ROOT.orgs[0], next_issue_num: 64 * 200 }] }
const WINDOWS = idWindows(64)

function serveBig(s: ReturnType<typeof scripted>) {
  serve(s)
  s.set('workspace:root', ROOT_ARGS, { value: BIG })
  for (const [i, w] of WINDOWS.entries())
    s.set('workspace:tasks', { org_id: ORG, ...w }, { value: tasksPart([`t${i}`]) })
}

/** The task windows of 64 watched for organization `org`. */
const watchedWindows = (s: ReturnType<typeof scripted>, org = ORG) =>
  WINDOWS.filter((w) => s.watched.has(s.keyOf('workspace:tasks', { org_id: org, ...w })))

/** Every task window watched, of any organization. */
const taskWatches = (s: ReturnType<typeof scripted>) =>
  [...s.watched.keys()].filter((k) => k.startsWith('workspace:tasks'))

describe('tasks on demand', () => {
  /** A registry over the large organization, with every part it watched
      answered: no task window unless made with the ask. */
  function big(opts?: Parameters<typeof createLiveParts>[3]) {
    const s = scripted()
    serveBig(s)
    const reports: PartsReport[] = []
    const parts = createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
      opts,
    )
    // the root, then every part it named
    s.send()
    s.send()
    const last = () => reports.at(-1)?.workspace
    const ids = () => {
      const w = last()
      return w?.state === 'partial' || w?.state === 'complete'
        ? (w.value?.issues.map((i) => i.id) ?? null)
        : null
    }
    return { s, parts, reports, last, ids }
  }

  it('subscribes no task window until asked, and reports the workspace complete without tasks', () => {
    const { s, last, ids, reports } = big()
    expect(taskWatches(s)).toEqual([])
    expect(last()).toMatchObject({ state: 'complete', tasks: 'not_asked' })
    expect(ids()).toEqual([])
    // the projects and the Inbox stay live
    s.set('workspace:projects', PROJECTS, { value: changedProjects('project-1') })
    s.send([s.keyOf('workspace:projects', PROJECTS)])
    expect(last()).toMatchObject({ state: 'complete', tasks: 'not_asked', changed: true })
    expect(reports.map((r) => r.workspace.state)).not.toContain('partial')
  })

  it('subscribes every task window at once on the ask, sized from the root as it stands then, and once', () => {
    const { s, parts } = big()
    // the organization's counts grew after it was added
    s.set('workspace:root', ROOT_ARGS, {
      value: { ...BIG, orgs: [{ ...BIG.orgs[0], next_issue_num: 128 * 200 }] },
    })
    s.send([s.keyOf('workspace:root', ROOT_ARGS)])
    expect(taskWatches(s)).toEqual([])
    parts.askTasks()
    expect(taskWatches(s)).toHaveLength(128)
    // a second ask subscribes nothing more
    const before = s.log.length
    parts.askTasks()
    expect(s.log.length).toBe(before)
  })

  it('reports partial without a task while the windows arrive, and complete with every task once all answered', () => {
    const { s, parts, last, ids, reports } = big()
    const before = reports.length
    parts.askTasks()
    // outside a transition the ask reports nothing
    expect(reports).toHaveLength(before)
    // the first windows answer: partial, no task, the share, no repaint
    s.send(WINDOWS.slice(0, 16).map((w) => s.keyOf('workspace:tasks', { org_id: ORG, ...w })))
    expect(last()).toMatchObject({ state: 'partial', loaded: 16 / 64, changed: false })
    expect(ids()).toEqual([])
    // another part changes: a partial that repaints
    s.set('workspace:projects', PROJECTS, { value: changedProjects('x') })
    s.send([s.keyOf('workspace:projects', PROJECTS)])
    expect(last()).toMatchObject({ state: 'partial', changed: true })
    // another part waits: held
    s.reconnect()
    s.send([s.keyOf('workspace:root', ROOT_ARGS)])
    expect(last()?.state).toBe('held')
    s.send()
    expect(last()).toMatchObject({ state: 'complete', tasks: 'all', changed: true })
    expect(ids()).toEqual(WINDOWS.map((_, i) => `t${i}`))
    // never partial again: after a reconnect it holds until every window is back
    s.reconnect()
    s.send([...s.watched.keys()].filter((k) => !k.startsWith('workspace:tasks')))
    expect(last()?.state).toBe('held')
    s.send()
    expect(last()).toMatchObject({ state: 'complete', tasks: 'all' })
  })

  it('never reports every task while an organization’s windows were not started', () => {
    const s = scripted()
    serveBig(s)
    serveOrg(s, 'org-2', 2)
    const reports: PartsReport[] = []
    const parts = createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
    )
    s.send([s.keyOf('workspace:root', ROOT_ARGS)])
    // the root answered and its organization's parts have not, so the ask waits
    parts.askTasks()
    expect(taskWatches(s)).toEqual([])
    // a second organization joins before every part answered
    s.set('workspace:root', ROOT_ARGS, {
      value: { ...BIG, orgs: [...BIG.orgs, orgRow('org-2', 2)] },
    })
    s.send([s.keyOf('workspace:root', ROOT_ARGS)])
    expect(taskWatches(s)).toEqual([])
    expect(reports.map((r) => r.workspace.state)).not.toContain('complete')
    // the first transition in which no part waits starts every window
    s.send()
    expect(watchedWindows(s)).toHaveLength(64)
    expect(taskWatches(s).filter((k) => k.includes('"org-2"'))).toHaveLength(2)
    expect(reports.at(-1)?.workspace).toMatchObject({ state: 'partial', loaded: 0 })
    s.send()
    expect(reports.at(-1)?.workspace).toMatchObject({ state: 'complete', tasks: 'all' })
    const w = reports.at(-1)?.workspace
    expect(w?.state === 'complete' && w.value?.issues).toHaveLength(64 + 2)
  })

  it('waits after a reconnect and starts the windows at the first settle in which no part waits', () => {
    const { s, parts, last } = big()
    s.reconnect()
    s.send([s.keyOf('workspace:root', ROOT_ARGS)])
    expect(last()?.state).toBe('held')
    parts.askTasks()
    expect(taskWatches(s)).toEqual([])
    s.send([...s.watched.keys()])
    expect(watchedWindows(s)).toHaveLength(64)
    expect(last()).toMatchObject({ state: 'partial', loaded: 0 })
  })

  it('gives an organization added after the ask its task windows before its projects', () => {
    const { s, parts } = big()
    parts.askTasks()
    s.send()
    serveOrg(s, 'org-2', 2)
    s.set('workspace:root', ROOT_ARGS, {
      value: { ...BIG, orgs: [...BIG.orgs, orgRow('org-2', 2)] },
    })
    const from = s.log.length
    s.send([s.keyOf('workspace:root', ROOT_ARGS)])
    const order = s.log
      .slice(from)
      .filter((l) => l.startsWith('watch ') && l.includes('org-2'))
      .map((l) => l.split('{')[0])
    expect(order).toContain('watch workspace:tasks')
    expect(order.lastIndexOf('watch workspace:tasks')).toBeLessThan(
      order.indexOf('watch workspace:projects'),
    )
  })

  it('stops only the task load when the windows stay silent, and fails the workspace when another part does', async () => {
    vi.useFakeTimers()
    STALL.ms = 1000
    const { s, parts, last } = big()
    for (const w of WINDOWS) s.set('workspace:tasks', { org_id: ORG, ...w }, {})
    parts.askTasks()
    await vi.advanceTimersByTimeAsync(999)
    expect(last()?.state).toBe('complete')
    await vi.advanceTimersByTimeAsync(1)
    const stalled = last()
    expect(stalled).toMatchObject({ state: 'partial' })
    expect(stalled?.state === 'partial' && String(stalled.tasksFailed)).toContain(
      'did not arrive in time',
    )
    // the rest stays live, and still says the load stopped
    s.set('workspace:projects', PROJECTS, { value: changedProjects('y') })
    s.send([s.keyOf('workspace:projects', PROJECTS)])
    const live = last()
    expect(live).toMatchObject({ state: 'partial', changed: true })
    expect(live?.state === 'partial' && live.tasksFailed).toBeTruthy()
    // Try again runs the silent windows again, and nothing else
    serveBig(s)
    const before = s.log.length
    expect(parts.retryTasks()).toBe(true)
    const again = s.log.slice(before).filter((l) => l.startsWith('watch '))
    expect(again).toHaveLength(64)
    expect(again.every((l) => l.startsWith('watch workspace:tasks'))).toBe(true)
    s.send()
    expect(last()).toMatchObject({ state: 'complete', tasks: 'all' })

    // a silent projects window during a load fails the workspace as before
    const t = big()
    for (const w of WINDOWS) t.s.set('workspace:tasks', { org_id: ORG, ...w }, {})
    t.parts.askTasks()
    t.s.reconnect()
    t.s.set('workspace:projects', PROJECTS, {})
    t.s.send([t.s.keyOf('workspace:root', ROOT_ARGS)])
    await vi.advanceTimersByTimeAsync(1000)
    expect(t.last()?.state).toBe('failed')
  })

  it('stops the task load only while its windows stay silent, and goes on loading once one answers', async () => {
    vi.useFakeTimers()
    STALL.ms = 1000
    const { s, parts, last } = big()
    for (const w of WINDOWS) s.set('workspace:tasks', { org_id: ORG, ...w }, {})
    parts.askTasks()
    await vi.advanceTimersByTimeAsync(1000)
    const stalled = last()
    expect(stalled?.state === 'partial' && String(stalled.tasksFailed)).toContain(
      'did not arrive in time',
    )
    // a window answers, and the load goes on with no failure
    const first = { org_id: ORG, ...WINDOWS[0] }
    s.set('workspace:tasks', first, { value: tasksPart(['t0']) })
    s.send([s.keyOf('workspace:tasks', first)])
    const loading = last()
    expect(loading).toMatchObject({ state: 'partial', loaded: 1 / 64 })
    expect(loading?.state === 'partial' && loading.tasksFailed).toBeUndefined()
    // after STALL.ms of silence the load stops again
    await vi.advanceTimersByTimeAsync(999)
    const quiet = last()
    expect(quiet?.state).toBe('partial')
    expect(quiet?.state === 'partial' && quiet.tasksFailed).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    const again = last()
    expect(again?.state === 'partial' && String(again.tasksFailed)).toContain(
      'did not arrive in time',
    )
    // Try again runs the silent windows again, not the one that answered
    serveBig(s)
    const before = s.log.length
    expect(parts.retryTasks()).toBe(true)
    const rerun = s.log.slice(before).filter((l) => l.startsWith('watch '))
    expect(rerun).toHaveLength(63)
    expect(rerun).not.toContain(`watch ${s.keyOf('workspace:tasks', first)}`)
  })

  it('names a failing task window in its partial reports, and Try again runs only the task windows again', () => {
    const { s, parts, last } = big()
    parts.askTasks()
    const first = { org_id: ORG, ...WINDOWS[0] }
    s.set('workspace:tasks', first, { error: new Error('boom') })
    s.send()
    const failed = last()
    expect(failed).toMatchObject({ state: 'partial' })
    expect(failed?.state === 'partial' && String(failed.tasksFailed)).toContain('boom')
    // a refusal stops the task load too
    s.set('workspace:tasks', first, { value: { state: 'refused', message: 'too large' } })
    expect(parts.retryTasks()).toBe(true)
    s.send()
    const refused = last()
    expect(refused?.state === 'partial' && String(refused.tasksFailed)).toContain('too large')
    // Try again: only the failed window runs again
    s.set('workspace:tasks', first, { value: tasksPart(['t0']) })
    const before = s.log.length
    expect(parts.retryTasks()).toBe(true)
    expect(s.log.slice(before).filter((l) => l.startsWith('watch '))).toEqual([
      `watch ${s.keyOf('workspace:tasks', first)}`,
    ])
    s.send()
    expect(last()).toMatchObject({ state: 'complete', tasks: 'all' })
    // nothing left to run again
    expect(parts.retryTasks()).toBe(false)
  })

  it('holds the workspace on a task window that fails once every task arrived', () => {
    const { s, parts, last } = big()
    parts.askTasks()
    s.send()
    expect(last()).toMatchObject({ state: 'complete', tasks: 'all' })
    const first = { org_id: ORG, ...WINDOWS[0] }
    s.set('workspace:tasks', first, { error: new Error('later') })
    s.send([s.keyOf('workspace:tasks', first)])
    expect(last()).toMatchObject({ state: 'failed' })
    expect(parts.retryTasks()).toBe(false)
    s.set('workspace:tasks', first, { value: tasksPart(['t0']) })
    expect(parts.retry()).toBe(true)
    s.send()
    expect(last()).toMatchObject({ state: 'complete', tasks: 'all' })
  })

  it('subscribes every task window from the start for a registry made with the ask', () => {
    const { s, reports, last } = big({ ask: true })
    expect(watchedWindows(s)).toHaveLength(64)
    // the task windows before the project windows
    const order = s.log.filter((l) => l.startsWith('watch ')).map((l) => l.split('{')[0])
    expect(order.lastIndexOf('watch workspace:tasks')).toBeLessThan(
      order.indexOf('watch workspace:projects'),
    )
    expect(last()).toMatchObject({ state: 'complete', tasks: 'all' })
    expect(reports.map((r) => r.workspace.state)).not.toContain('partial')
  })

  it('sizes the windows by the active tasks and projects, not by the numbers handed out', async () => {
    // 12,800 task and 4,001 project numbers, of which 300 tasks are active
    // and 10 projects are left, so it gets two task windows and one project
    // window
    const s = scripted()
    serve(s)
    const aged = { ...BIG.orgs[0], next_project_num: 4001, active_tasks: 300, live_projects: 10 }
    s.set('workspace:root', ROOT_ARGS, { value: { ...BIG, orgs: [aged] } })
    const reports: PartsReport[] = []
    const parts = createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
    )
    s.send()
    expect([...s.watched.keys()].filter((k) => k.startsWith('workspace:projects'))).toHaveLength(1)
    await tick()
    s.send()
    parts.askTasks()
    expect(taskWatches(s)).toEqual(
      [LEFT, RIGHT].map((w) => s.keyOf('workspace:tasks', { org_id: ORG, ...w })),
    )
    s.send()
    const w = reports.at(-1)?.workspace
    expect(w?.state === 'complete' && w.value?.issues.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps a split window serving and waits for an overflowing one’s pieces during the load', () => {
    const { s, parts, last, ids } = big()
    parts.askTasks()
    const [first, second] = WINDOWS.map((w) => ({ org_id: ORG, ...w }))
    s.set('workspace:tasks', first, { value: tasksPart(['t0'], { split: true }) })
    s.set('workspace:tasks', second, { value: { state: 'overflow' } })
    s.send()
    // no task in a partial report, and the share counts the split window
    expect(last()).toMatchObject({ state: 'partial', loaded: 63 / 64 })
    expect(ids()).toEqual([])
    const [left, right] = idWindows(128).slice(0, 2)
    const [p0, p1] = idWindows(128).slice(2, 4)
    s.set('workspace:tasks', { org_id: ORG, ...left }, { value: tasksPart(['t0']) })
    s.set('workspace:tasks', { org_id: ORG, ...right }, { value: tasksPart(['t0b']) })
    s.set('workspace:tasks', { org_id: ORG, ...p0 }, { value: tasksPart(['p0']) })
    s.set('workspace:tasks', { org_id: ORG, ...p1 }, { value: tasksPart(['p1']) })
    s.send()
    expect(last()).toMatchObject({ state: 'complete', tasks: 'all' })
    expect(ids()).toEqual(expect.arrayContaining(['t0', 'p0', 'p1', 't63']))
    expect(ids()).not.toContain('t1')
  })

  it("reads the boot address's task with the first parts, and subscribes no task window for it", () => {
    const s = scripted()
    serveBig(s)
    s.set('workspace:root', ROOT_ARGS, {
      value: { ...BIG, orgs: [{ ...BIG.orgs[0], slug: 'northstar' }] },
    })
    const reports: PartsReport[] = []
    const parts = createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
      { address: { slug: 'NorthStar', ref: 'QN-12' } },
    )
    const args = { org_id: ORG, ref: 'QN-12' }
    const key = s.keyOf('taskWindow:task', args)
    // nothing before the root answered
    expect(s.watched.has(key)).toBe(false)
    s.send([s.keyOf('workspace:root', ROOT_ARGS)])
    // ahead of the organization's parts, and no task window
    const order = s.log.filter((l) => l.startsWith('watch ')).map((l) => l.split('{')[0])
    expect(order.indexOf('watch taskWindow:task')).toBeLessThan(
      order.indexOf('watch workspace:projects'),
    )
    expect(parts.sideArgs('reference')).toEqual(args)
    expect(taskWatches(s)).toEqual([])
    // its answer comes with the first complete workspace, which holds no task
    s.set('taskWindow:task', args, { value: { state: 'ok', task: { id: 't12' } } })
    s.send()
    expect(reports.at(-1)).toMatchObject({
      workspace: { state: 'complete', tasks: 'not_asked' },
      sides: { reference: { value: { state: 'ok' } } },
    })
    // every report names its connection
    expect(reports.every((r) => r.connection === 1)).toBe(true)
    // its failure holds nothing
    s.set('taskWindow:task', args, { error: new Error('task failed') })
    s.send()
    expect(reports.at(-1)?.workspace.state).toBe('complete')
    expect(taskWatches(s)).toEqual([])
    // a slug the root does not name reads nothing
    const t = scripted()
    serveBig(t)
    createLiveParts(
      t.live,
      () => {},
      () => true,
      { address: { slug: 'globex', ref: 'QN-12' } },
    )
    t.send()
    expect([...t.watched.keys()].some((k) => k.startsWith('taskWindow:'))).toBe(false)
  })

  it('weights the share loaded by each organization’s tasks', () => {
    const s = scripted()
    serveBig(s)
    serveOrg(s, 'org-2', 1)
    s.set('workspace:root', ROOT_ARGS, {
      value: { ...BIG, orgs: [...BIG.orgs, orgRow('org-2', 1)] },
    })
    const reports: PartsReport[] = []
    const parts = createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
    )
    s.send()
    s.send()
    parts.askTasks()
    // org-2's one window holds its 200 task numbers, and org-1's first 7 of
    // 64 windows 1,400 of its 12,800
    s.send([
      s.keyOf('workspace:tasks', { org_id: 'org-2', from: '', to: null }),
      ...WINDOWS.slice(0, 7).map((w) => s.keyOf('workspace:tasks', { org_id: ORG, ...w })),
    ])
    const w = reports.at(-1)?.workspace
    expect(w?.state).toBe('partial')
    expect(w?.state === 'partial' && w.loaded).toBeCloseTo(1600 / 13000)
  })
})

/** A root row for organization `id` with `windows` task windows. */
const orgRow = (id: string, windows: number) => ({
  id,
  name: id,
  next_issue_num: windows * 200,
  next_project_num: 1,
})

/** Serves organization `id` with `windows` task windows, task <id>-<i> in
    window i. */
function serveOrg(s: ReturnType<typeof scripted>, id: string, windows: number) {
  for (const [name, value] of Object.entries(EMPTY))
    s.set(name, { org_id: id, from: '', to: null }, { value })
  for (const [i, w] of idWindows(windows).entries())
    s.set('workspace:tasks', { org_id: id, ...w }, { value: tasksPart([`${id}-${i}`]) })
}

describe('the parts an organization subscribes', () => {
  it('watches no people, catalog or inbox part, and joins the caller’s own rows from the root', async () => {
    const s = scripted()
    serve(s)
    s.set('workspace:root', ROOT_ARGS, {
      value: {
        ...ROOT,
        profiles: [{ id: 'me', org_id: ORG, name: 'Me' }],
        teamMembers: [
          { team_id: 'mine', profile_id: 'me', is_leader: false },
          // a membership of a team the root does not name joins nothing
          { team_id: 'elsewhere', profile_id: 'me', is_leader: false },
        ],
        teams: [{ id: 'mine', org_id: ORG, name: 'Mine' }],
      },
    })
    const reports: PartsReport[] = []
    createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
    )
    s.send()
    await tick()
    s.send()
    const watched = s.log.filter((l) => l.startsWith('watch ')).map((l) => l.split('{')[0])
    expect(watched).not.toContain('watch workspace:people')
    expect(watched).not.toContain('watch workspace:catalog')
    expect(watched).not.toContain('watch workspace:inbox')
    // the feed waits for the desktop alert client, which watches it with a floor
    expect(watched).not.toContain('watch inbox:feed')
    expect(new Set(watched)).toEqual(
      new Set(['watch workspace:root', 'watch inbox:summary', 'watch workspace:projects']),
    )
    const w = reports.at(-1)?.workspace
    if (w?.state !== 'complete' || !w.value) throw new Error(`not complete: ${w?.state}`)
    expect(w.value.profiles.map((p) => p.id)).toEqual(['me'])
    expect(w.value.teams.map((t) => t.id)).toEqual(['mine'])
    expect(w.value.teamMembers.map((m) => m.team_id)).toEqual(['mine'])
    expect(w.value).not.toHaveProperty('labels')
  })

  it('fails the workspace with the sentence of a refused root', async () => {
    const s = scripted()
    serve(s)
    const reports: PartsReport[] = []
    createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
    )
    s.set('workspace:root', ROOT_ARGS, {
      error: new ConvexError({ code: 'rule', message: 'Qivo could not finish checking.' }),
    })
    s.send()
    const w = reports.at(-1)?.workspace
    expect(w?.state).toBe('failed')
    expect(w?.state === 'failed' && (w.error as { data: unknown }).data).toEqual({
      code: 'rule',
      message: 'Qivo could not finish checking.',
    })
  })
})

describe("the Inbox's unread summary side", () => {
  const summaryKey = (s: ReturnType<typeof scripted>) => s.keyOf('inbox:summary', {})

  it('is watched as the registry starts, right after the root part and before it answers', () => {
    const s = scripted()
    serve(s)
    const reports: PartsReport[] = []
    createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
    )
    expect(s.log).toEqual([
      `watch ${s.keyOf('workspace:root', ROOT_ARGS)}`,
      `watch ${summaryKey(s)}`,
    ])
    expect(reports).toEqual([])
  })

  it('is watched again by every new registry, as a retry or a re-init starts one', () => {
    const s = scripted()
    serve(s)
    const first = createLiveParts(
      s.live,
      () => {},
      () => true,
    )
    first.stop()
    expect(s.watched.has(summaryKey(s))).toBe(false)
    createLiveParts(
      s.live,
      () => {},
      () => true,
    )
    expect(s.log.filter((line) => line === `watch ${summaryKey(s)}`)).toHaveLength(2)
    expect(s.watched.get(summaryKey(s))).toBe(1)
  })

  it('reports its news with the transition that brought it, and its failure holds nothing', async () => {
    const { s, reports, last } = await started()
    const catalog = s.keyOf('workspace:projects', PROJECTS)
    s.set('inbox:summary', {}, { value: { unread_count: 3 } })
    s.set('workspace:projects', PROJECTS, { value: changedProjects('x') })
    const count = reports.length
    s.send([summaryKey(s), catalog])
    expect(reports).toHaveLength(count + 1)
    expect(reports.at(-1)?.sides).toEqual({ summary: { value: { unread_count: 3 } } })
    expect(last()).toMatchObject({ state: 'complete', changed: true })
    s.set('inbox:summary', {}, { error: new Error('summary failed') })
    s.send([summaryKey(s)])
    expect(reports.at(-1)?.sides).toEqual({ summary: { error: expect.any(Error) } })
    expect(last()?.state).toBe('complete')
  })

  it('runs a failed summary again from a fresh subscription, and nothing that answered', async () => {
    const { s, parts, reports } = await started()
    s.set('inbox:summary', {}, { error: new Error('summary failed') })
    s.send([summaryKey(s)])
    s.log.length = 0
    expect(parts.rerunSide('summary')).toBe(true)
    expect(s.log).toEqual([`stop ${summaryKey(s)}`, `watch ${summaryKey(s)}`])
    s.set('inbox:summary', {}, { value: { unread_count: 0 } })
    s.send([summaryKey(s)])
    expect(reports.at(-1)?.sides).toEqual({ summary: { value: { unread_count: 0 } } })
    s.log.length = 0
    expect(parts.rerunSide('summary')).toBe(false)
    expect(parts.rerunSide('thread')).toBe(false)
    expect(s.log).toEqual([])
  })
})
