import { type FunctionReference, getFunctionName, makeFunctionReference } from 'convex/server'
import type { Value } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { idWindows } from '../../convex/lib/idWindows'
import type { ConnectionChange, LiveQueries, LiveTransition } from '../lib/liveQueries'
import { BOUND, createLiveParts, type PartsReport, STAGES, STALL } from './liveParts'

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
}
const LEFT = { from: '', to: '80000000' }
const RIGHT = { from: '80000000', to: null }
const ok = (rows: Record<string, unknown[]>) => ({ state: 'ok', ...rows })
const task = (id: string) => ({ id, org_id: ORG, title: id })
const EMPTY = {
  'workspace:catalog': ok({ teams: [], labels: [] }),
  'workspace:inbox': {
    state: 'ok',
    unread: [],
    read: [],
    readMessageCount: 0,
    unreadTruncated: false,
    readTruncated: false,
    truncated: false,
  },
  'workspace:people': ok({ profiles: [], teamMembers: [] }),
  'workspace:projects': ok({ projects: [], access: [], teamAccess: [], milestones: [] }),
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
  const connections = new Set<(c: ConnectionChange) => void>()
  // the watched parts with no answer on this connection; the most at once,
  // and the most a connection was asked for between two transitions, which
  // is what the server runs in one update
  const unanswered = new Set<string>()
  const most = { unanswered: 0, asked: 0 }
  let asked = 0
  const ask = (n: number) => {
    asked += n
    most.unanswered = Math.max(most.unanswered, unanswered.size)
    most.asked = Math.max(most.asked, asked)
  }
  const keyOf = (name: string, args: Record<string, unknown>) => `${name}${JSON.stringify(args)}`
  let at = 1
  let connection = 1
  const live: LiveQueries = {
    watch(ref: FunctionReference<'query'>, args: Record<string, Value>) {
      const token = keyOf(getFunctionName(ref), args)
      watched.set(token, (watched.get(token) ?? 0) + 1)
      log.push(`watch ${token}`)
      failedRun.delete(token)
      unanswered.add(token)
      ask(1)
      return {
        token,
        stop: () => {
          log.push(`stop ${token}`)
          const n = (watched.get(token) ?? 1) - 1
          if (n) watched.set(token, n)
          else {
            watched.delete(token)
            unanswered.delete(token)
          }
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
    onConnection(fn) {
      connections.add(fn)
      return () => connections.delete(fn)
    },
    query: (async () => null) as LiveQueries['query'],
  }
  return {
    live,
    watched,
    log,
    most,
    /** The `n` watched parts that went longest without an answer. */
    oldest: (n: number) => [...unanswered].slice(0, n),
    /** Sets the answer of part `name` with `args`. */
    set(name: string, args: Record<string, unknown>, answer: { value?: unknown; error?: unknown }) {
      answers.set(keyOf(name, args), answer)
    },
    /** Sends a transition naming the watched parts given, or all watched. */
    send(tokens = [...watched.keys()]) {
      at++
      for (const token of tokens) unanswered.delete(token)
      asked = 0
      for (const fn of handlers) fn({ tokens: new Set(tokens), at, connection })
    },
    /** Drops the socket, for the server's load when `overloaded`. */
    drop(overloaded = false) {
      for (const fn of connections) fn({ connected: false, overloaded })
    },
    /** Starts the next connection; Convex tells of it when the socket
        dropped first. */
    reconnect() {
      connection++
      // the new connection asks for every watched part at once, in an
      // update of their own, and the server runs what comes after it in the
      // next one
      for (const token of watched.keys()) unanswered.add(token)
      asked = 0
      ask(watched.size)
      asked = 0
      for (const fn of connections) fn({ connected: true, overloaded: false })
    },
    keyOf,
  }
}

/* A server holding tasks a and b in the first task window and c in the
   second. */
function serve(s: ReturnType<typeof scripted>) {
  s.set('workspace:root', {}, { value: ROOT })
  for (const [name, value] of Object.entries(EMPTY)) {
    const args = name === 'workspace:catalog' || name === 'workspace:inbox' ? { org_id: ORG } : null
    if (args) s.set(name, args, { value })
    else s.set(name, { org_id: ORG, from: '', to: null }, { value })
  }
  s.set('workspace:tasks', { org_id: ORG, ...LEFT }, { value: tasksPart(['a', 'b']) })
  s.set('workspace:tasks', { org_id: ORG, ...RIGHT }, { value: tasksPart(['c']) })
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function started() {
  const s = scripted()
  serve(s)
  const reports: PartsReport[] = []
  const parts = createLiveParts(
    s.live,
    (r) => reports.push(r),
    () => true,
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
    )
    s.send()
    // the root answered, the parts not yet
    expect(reports.at(-1)?.workspace.state).toBe('held')
    await tick()
    s.send()
    const w = reports.at(-1)?.workspace
    expect(w?.state === 'complete' && w.value?.issues.map((i) => i.id)).toEqual(['a', 'b', 'c'])
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
    s.send([s.keyOf('workspace:root', {})])
    expect(last()?.state).toBe('held')
    s.send()
    expect(last()?.state).toBe('complete')
  })

  it('fails on a failed or refusing part, and Retry runs only that part again', async () => {
    const { s, parts, last } = await started()
    const inbox = s.keyOf('workspace:inbox', { org_id: ORG })
    s.set('workspace:inbox', { org_id: ORG }, { error: new Error('boom') })
    s.send([inbox])
    expect(last()).toMatchObject({ state: 'failed' })
    s.set('workspace:inbox', { org_id: ORG }, { value: EMPTY['workspace:inbox'] })
    // the failed run stays until the part is watched again
    s.send([inbox])
    expect(last()).toMatchObject({ state: 'failed' })
    s.log.length = 0
    expect(parts.retry()).toBe(true)
    expect(s.log).toEqual([`stop ${inbox}`, `watch ${inbox}`])
    s.send([inbox])
    expect(last()?.state).toBe('complete')
    const people = { org_id: ORG, from: '', to: null }
    const peopleKey = s.keyOf('workspace:people', people)
    s.set('workspace:people', people, { value: { state: 'refused', message: 'Too much.' } })
    s.send([peopleKey])
    const failed = last()
    expect(failed?.state === 'failed' && (failed.error as { data: unknown }).data).toEqual({
      code: 'rule',
      message: 'Too much.',
    })
    s.log.length = 0
    expect(parts.retry()).toBe(true)
    expect(s.log).toEqual([`stop ${peopleKey}`, `watch ${peopleKey}`])
    s.set('workspace:people', people, { value: EMPTY['workspace:people'] })
    s.send([peopleKey])
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
    s.set('workspace:root', {}, { value: { ...ROOT, orgs: [] } })
    s.send([s.keyOf('workspace:root', {})])
    expect(ids()).toEqual([])
    expect([...s.watched.keys()].every((key) => !key.includes(ORG))).toBe(true)
    s.set('workspace:root', {}, { value: null })
    s.send([s.keyOf('workspace:root', {})])
    expect(last()).toMatchObject({ state: 'complete', value: null })
  })

  it('a failed side query rides along without failing or holding the workspace', async () => {
    const { s, parts, reports, last } = await started()
    parts.watchSide(makeFunctionReference<'query'>('snapshot:commentThread'), { issue_id: 't' })
    const side = s.keyOf('snapshot:commentThread', { issue_id: 't' })
    s.set('snapshot:commentThread', { issue_id: 't' }, { error: new Error('thread failed') })
    s.send([side])
    expect(last()?.state).toBe('complete')
    expect(reports.at(-1)?.side).toMatchObject({ error: expect.any(Error) })
  })

  it('fails a workspace that stays incomplete with no part answering while online, and waits while offline', async () => {
    vi.useFakeTimers()
    STALL.ms = 1000
    const s = scripted()
    serve(s)
    s.set('workspace:inbox', { org_id: ORG }, {})
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
    s.send([s.keyOf('workspace:catalog', { org_id: ORG })])
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
    s.set('workspace:inbox', { org_id: ORG }, {})
    const reports: PartsReport[] = []
    const parts = createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
    )
    parts.watchSide(makeFunctionReference<'query'>('snapshot:commentThread'), { issue_id: 't' })
    s.send()
    await vi.advanceTimersByTimeAsync(0)
    s.send()
    expect(reports.at(-1)?.workspace.state).toBe('held')
    const side = s.keyOf('snapshot:commentThread', { issue_id: 't' })
    for (let i = 0; i < 4; i++) {
      s.set('snapshot:commentThread', { issue_id: 't' }, { value: { comments: [i] } })
      s.send([side])
      await vi.advanceTimersByTimeAsync(400)
    }
    expect(reports.some((r) => r.workspace.state === 'failed')).toBe(true)
  })
})

/* An organization of 12,800 task numbers: 64 task windows, more parts than
   STAGES.most, so it loads in stages. Window i holds task t<i>. */
const BIG = { ...ROOT, orgs: [{ ...ROOT.orgs[0], next_issue_num: 64 * 200 }] }
const WINDOWS = idWindows(64)

function serveBig(s: ReturnType<typeof scripted>) {
  serve(s)
  s.set('workspace:root', {}, { value: BIG })
  for (const [i, w] of WINDOWS.entries())
    s.set('workspace:tasks', { org_id: ORG, ...w }, { value: tasksPart([`t${i}`]) })
}

/** The task windows of 64 watched for organization `org`. */
const watchedWindows = (s: ReturnType<typeof scripted>, org = ORG) =>
  WINDOWS.filter((w) => s.watched.has(s.keyOf('workspace:tasks', { org_id: org, ...w })))

describe('a staged load', () => {
  const stages = { ...STAGES }
  const bound = { ...BOUND }
  beforeEach(() => {
    Object.assign(STAGES, { most: 32, first: 8, batch: 32 })
    // these stages run without waves (a bounded load)
    BOUND.wave = Number.POSITIVE_INFINITY
  })
  afterEach(() => {
    Object.assign(STAGES, stages)
    Object.assign(BOUND, bound)
  })

  function big() {
    const s = scripted()
    serveBig(s)
    const reports: PartsReport[] = []
    const parts = createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
    )
    s.send()
    const last = () => reports.at(-1)?.workspace
    const ids = () => {
      const w = last()
      return w?.state === 'partial' || w?.state === 'complete'
        ? w.value?.issues.map((i) => i.id)
        : null
    }
    return { s, parts, reports, last, ids }
  }

  it('reports a large workspace partial, stage by stage, before it completes, and a small one never', async () => {
    const { s, last, ids } = big()
    // every part but the task windows, and the first stage of those
    expect(watchedWindows(s)).toEqual(WINDOWS.slice(0, STAGES.first))
    s.send()
    expect(last()).toMatchObject({ state: 'partial', loaded: STAGES.first / 64 })
    expect(ids()).toEqual(WINDOWS.slice(0, STAGES.first).map((_, i) => `t${i}`))
    // the next stage, once every part watched so far answered
    expect(watchedWindows(s)).toHaveLength(STAGES.first + STAGES.batch)
    s.send()
    expect(last()?.state).toBe('partial')
    expect(ids()).toHaveLength(STAGES.first + STAGES.batch)
    s.send()
    expect(last()?.state).toBe('complete')
    expect(ids()).toEqual(WINDOWS.map((_, i) => `t${i}`))
    // a small workspace subscribes every part at once and is never partial
    const small = await started()
    expect(small.reports.map((r) => r.workspace.state)).not.toContain('partial')
    expect(small.last()?.state).toBe('complete')
  })

  it('watches the first task windows before the people and project windows', () => {
    const { s } = big()
    const order = s.log.filter((l) => l.startsWith('watch ')).map((l) => l.split('{')[0])
    expect(order.lastIndexOf('watch workspace:tasks')).toBeLessThan(
      order.indexOf('watch workspace:people'),
    )
    expect(order.lastIndexOf('watch workspace:tasks')).toBeLessThan(
      order.indexOf('watch workspace:projects'),
    )
  })

  it('starts the next stage only once every part watched answered', () => {
    const { s, last } = big()
    // the catalog alone answered
    s.send([s.keyOf('workspace:catalog', { org_id: ORG })])
    expect(last()?.state).toBe('held')
    expect(watchedWindows(s)).toHaveLength(STAGES.first)
  })

  it('keeps a split window serving, leaves an overflowing one out, and fails on a failing part', () => {
    const { s, last, ids } = big()
    s.send()
    const [first, second, third] = WINDOWS.map((w) => ({ org_id: ORG, ...w }))
    s.set('workspace:tasks', first, { value: tasksPart(['t0'], { split: true }) })
    s.set('workspace:tasks', second, { value: { state: 'overflow' } })
    s.send([s.keyOf('workspace:tasks', first), s.keyOf('workspace:tasks', second)])
    // the halves and pieces are watched and hold the stage
    expect(last()?.state).toBe('held')
    // the halves answer; the overflowing window's pieces do not yet
    const [left, right] = idWindows(128).slice(0, 2)
    for (const [w, id] of [
      [left, 't0'],
      [right, 't0b'],
    ] as const)
      s.set('workspace:tasks', { org_id: ORG, ...w }, { value: tasksPart([id]) })
    // the overflow named no count, so the window gives way to its halves
    const [p0, p1] = idWindows(128).slice(2, 4)
    s.set('workspace:tasks', { org_id: ORG, ...p0 }, { value: tasksPart(['p0']) })
    s.set('workspace:tasks', { org_id: ORG, ...p1 }, { value: tasksPart(['p1']) })
    s.send()
    // the split window shows its rows while it waits for the complete
    // transition to give way; the overflowing one's rows came in pieces
    expect(last()?.state).toBe('partial')
    expect(ids()).toContain('t0')
    expect(ids()).toEqual(expect.arrayContaining(['p0', 'p1']))
    expect(ids()).not.toContain('t1')
    s.set('workspace:tasks', third, { error: new Error('boom') })
    s.send([s.keyOf('workspace:tasks', third)])
    expect(last()).toMatchObject({ state: 'failed' })
  })

  it('is never partial again after its first complete transition, nor stages an organization added then', () => {
    const { s, reports } = big()
    s.send()
    s.send()
    s.send()
    expect(reports.at(-1)?.workspace.state).toBe('complete')
    s.reconnect()
    s.send([s.keyOf('workspace:root', {})])
    expect(reports.at(-1)?.workspace.state).toBe('held')
    s.send()
    expect(reports.at(-1)?.workspace.state).toBe('complete')
    // a large organization joins: every window of it is watched at once,
    // and the workspace holds until all of them answered
    serveOrg(s, 'org-2', 64)
    s.set('workspace:root', {}, { value: { ...BIG, orgs: [...BIG.orgs, orgRow('org-2', 64)] } })
    const before = reports.length
    s.send([s.keyOf('workspace:root', {})])
    expect(watchedWindows(s, 'org-2')).toHaveLength(64)
    s.send([...s.watched.keys()].filter((t) => !t.includes('"org_id":"org-2"')))
    expect(reports.at(-1)?.workspace.state).toBe('held')
    s.send()
    expect(reports.at(-1)?.workspace.state).toBe('complete')
    expect(reports.slice(before).map((r) => r.workspace.state)).not.toContain('partial')
  })

  it('loads in one stage, never partial, for a boot that waits for the whole workspace', () => {
    const s = scripted()
    serveBig(s)
    const reports: PartsReport[] = []
    createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
      { whole: true },
    )
    s.send()
    expect(watchedWindows(s)).toHaveLength(64)
    s.send()
    expect(reports.map((r) => r.workspace.state)).not.toContain('partial')
    expect(reports.at(-1)?.workspace.state).toBe('complete')
  })

  it('watches no later window once a part of the stage failed', () => {
    const { s, last } = big()
    s.set('workspace:tasks', { org_id: ORG, ...WINDOWS[0] }, { error: new Error('boom') })
    s.send()
    expect(last()).toMatchObject({ state: 'failed' })
    expect(watchedWindows(s)).toHaveLength(STAGES.first)
  })

  it('watches every window of several large organizations whose first stage they share', () => {
    const s = scripted()
    serveBig(s)
    serveOrg(s, 'org-2', 64)
    serveOrg(s, 'org-3', 64)
    s.set(
      'workspace:root',
      {},
      {
        value: { ...BIG, orgs: [...BIG.orgs, orgRow('org-2', 64), orgRow('org-3', 64)] },
      },
    )
    const reports: PartsReport[] = []
    createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
    )
    // a first stage of 8 windows ends inside a turn of the three
    for (let i = 0; i < 12 && reports.at(-1)?.workspace.state !== 'complete'; i++) s.send()
    expect(reports.at(-1)?.workspace.state).toBe('complete')
    for (const org of [ORG, 'org-2', 'org-3']) expect(watchedWindows(s, org)).toHaveLength(64)
    const w = reports.at(-1)?.workspace
    expect(w?.state === 'complete' && w.value?.issues).toHaveLength(64 * 3)
  })

  it('weights the share loaded by each organization’s tasks', () => {
    const s = scripted()
    serveBig(s)
    serveOrg(s, 'org-2', 1)
    s.set('workspace:root', {}, { value: { ...BIG, orgs: [...BIG.orgs, orgRow('org-2', 1)] } })
    const reports: PartsReport[] = []
    createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
    )
    s.send()
    // the first stage takes each organization's windows in turn: org-2's
    // one window holds its 200 task numbers, and org-1's first 7 of 64
    // windows 1,400 of its 12,800
    expect(s.watched.has(s.keyOf('workspace:tasks', { org_id: 'org-2', from: '', to: null }))).toBe(
      true,
    )
    expect(watchedWindows(s)).toHaveLength(STAGES.first - 1)
    s.send()
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
  for (const [name, value] of Object.entries(EMPTY)) {
    const args =
      name === 'workspace:catalog' || name === 'workspace:inbox'
        ? { org_id: id }
        : { org_id: id, from: '', to: null }
    s.set(name, args, { value })
  }
  for (const [i, w] of idWindows(windows).entries())
    s.set('workspace:tasks', { org_id: id, ...w }, { value: tasksPart([`${id}-${i}`]) })
}

describe('a bounded load', () => {
  const bound = { ...BOUND }
  beforeEach(() => {
    Object.assign(BOUND, { wave: 8, least: 2 })
  })
  afterEach(() => {
    Object.assign(BOUND, bound)
  })

  /** A large workspace booting; `onWait` hears whether it waits for the
      server. */
  function big(onWait?: (waiting: boolean) => void) {
    const s = scripted()
    serveBig(s)
    const reports: PartsReport[] = []
    createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
      { onWait },
    )
    const state = () => reports.at(-1)?.workspace.state
    /** Sends transitions, each answering the `each` parts that waited
        longest, all of them unless given, until the workspace completes. */
    const complete = (each?: number) => {
      for (let i = 0; i < 200 && state() !== 'complete'; i++)
        s.send(each ? s.oldest(each) : undefined)
      expect(state()).toBe('complete')
    }
    const ids = () => {
      const w = reports.at(-1)?.workspace
      return w?.state === 'complete' ? w.value?.issues.map((i) => i.id) : null
    }
    return { s, reports, state, complete, ids }
  }
  const all = WINDOWS.map((_, i) => `t${i}`)

  it('asks for at most a wave between two transitions and has at most two unanswered, still painting in stages', () => {
    for (const each of [undefined, 3]) {
      const { s, reports, complete, ids } = big()
      complete(each)
      expect(ids()).toEqual(all)
      expect(reports.map((r) => r.workspace.state)).toContain('partial')
      expect(s.most.asked).toBeLessThanOrEqual(BOUND.wave)
      expect(s.most.unanswered).toBeLessThanOrEqual(2 * BOUND.wave)
    }
  })

  it('after a drop, asks for one wave on the next connection and the rest as parts answer, keeping the workspace it showed', () => {
    const { s, reports, complete, ids } = big()
    complete()
    const before = reports.length
    Object.assign(s.most, { asked: 0, unanswered: 0 })
    s.drop()
    expect(s.watched.size).toBe(BOUND.wave)
    s.reconnect()
    expect(s.most.asked).toBe(BOUND.wave)
    expect(s.most.unanswered).toBe(2 * BOUND.wave)
    complete()
    // held while parts arrived again: never less than it showed, never a
    // mix of the old and the new
    expect(
      reports
        .slice(before, -1)
        .map((r) => r.workspace.state)
        .every((state) => state === 'held'),
    ).toBe(true)
    expect(ids()).toEqual(all)
    expect(s.most.asked).toBeLessThanOrEqual(BOUND.wave)
    expect(s.most.unanswered).toBeLessThanOrEqual(2 * BOUND.wave)
  })

  it('asks for fewer parts after each close for the server’s load, and for a full wave again once complete', () => {
    const { s, complete } = big()
    s.send()
    s.send()
    s.drop(true)
    expect(s.watched.size).toBe(BOUND.wave / 2)
    s.reconnect()
    s.drop(true)
    expect(s.watched.size).toBe(BOUND.wave / 4)
    s.reconnect()
    s.drop(true)
    expect(s.watched.size).toBe(BOUND.least)
    s.reconnect()
    complete()
    s.drop()
    expect(s.watched.size).toBe(BOUND.wave)
  })

  it('says it waits for the server from a drop until a part answers again', () => {
    const waits: boolean[] = []
    const { s } = big((waiting) => waits.push(waiting))
    s.send()
    expect(waits).toEqual([])
    s.drop(true)
    s.reconnect()
    expect(waits).toEqual([true])
    s.send([s.keyOf('workspace:root', {})])
    expect(waits).toEqual([true, false])
  })

  it('keeps a refusal after a drop a refusal, and asks for no more parts while it holds', () => {
    const { s, complete, state } = big()
    complete()
    s.drop()
    s.reconnect()
    const watched = s.watched.size
    const catalog = { org_id: ORG }
    s.set('workspace:catalog', catalog, { value: { state: 'refused', message: 'No access.' } })
    s.send([s.keyOf('workspace:root', {}), s.keyOf('workspace:catalog', catalog)])
    expect(state()).toBe('failed')
    s.send()
    expect(state()).toBe('failed')
    // the parts still in line wait while the refusal holds the workspace
    expect(s.watched.size).toBe(watched)
    expect(watched).toBeLessThanOrEqual(2 * BOUND.wave)
  })
})
