import { type FunctionReference, getFunctionName, makeFunctionReference } from 'convex/server'
import type { Value } from 'convex/values'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveQueries, LiveTransition } from '../lib/liveQueries'
import { createLiveParts, type PartsReport, STALL } from './liveParts'

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
  const handlers = new Set<(t: LiveTransition) => void>()
  const keyOf = (name: string, args: Record<string, unknown>) => `${name}${JSON.stringify(args)}`
  let at = 1
  let connection = 1
  const live: LiveQueries = {
    watch(ref: FunctionReference<'query'>, args: Record<string, Value>) {
      const token = keyOf(getFunctionName(ref), args)
      watched.set(token, (watched.get(token) ?? 0) + 1)
      return {
        token,
        stop: () => {
          const n = (watched.get(token) ?? 1) - 1
          if (n) watched.set(token, n)
          else watched.delete(token)
        },
      }
    },
    read(token) {
      const a = answers.get(token)
      if (a?.error !== undefined) throw a.error
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
    const before = new Map(s.watched)
    expect(parts.retry()).toBe(true)
    // the same subscriptions, the failed one taken again
    expect(s.watched).toEqual(before)
    s.set('workspace:inbox', { org_id: ORG }, { value: EMPTY['workspace:inbox'] })
    s.send([inbox])
    expect(last()?.state).toBe('complete')
    const people = { org_id: ORG, from: '', to: null }
    s.set('workspace:people', people, { value: { state: 'refused', message: 'Too much.' } })
    s.send([s.keyOf('workspace:people', people)])
    const failed = last()
    expect(failed?.state === 'failed' && (failed.error as { data: unknown }).data).toEqual({
      code: 'rule',
      message: 'Too much.',
    })
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
})
