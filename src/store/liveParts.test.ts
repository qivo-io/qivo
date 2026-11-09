import { type FunctionReference, getFunctionName, makeFunctionReference } from 'convex/server'
import { ConvexError, type Value } from 'convex/values'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveQueries, LiveTransition } from '../lib/liveQueries'
import { createLiveParts, type PartsReport, STALL, VIEW_SIDES } from './liveParts'

/* The root part's arguments, none (convex/workspace.ts root). */
const ROOT_ARGS = {}

/* The registry over a scripted transport: the test plays the server, sets
   what the root part and each side query answer and sends transitions
   naming the subscriptions that changed. */

const ORG = 'org-1'
const ROOT = {
  auth_user_id: 'a',
  myProfileIds: ['me'],
  orgs: [{ id: ORG, name: 'Org', next_issue_num: 300 }],
  // the caller's own rows, which the root carries (convex/lib/workspaceParts.ts readRoot)
  profiles: [],
  teamMembers: [],
  teams: [],
  create: 'now',
}
// the root's answer with the organization renamed, as a change elsewhere
// sends it
const renamedRoot = (name: string) => ({ ...ROOT, orgs: [{ ...ROOT.orgs[0], name }] })
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

/* A server whose root part answers ROOT. */
function serve(s: ReturnType<typeof scripted>) {
  s.set('workspace:root', ROOT_ARGS, { value: ROOT })
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// the task window's side queries
const THREAD = makeFunctionReference<'query'>('snapshot:threadComments')
const HISTORY = makeFunctionReference<'query'>('snapshot:threadHistory')
const TASK = makeFunctionReference<'query'>('taskWindow:task')
const LINKS = makeFunctionReference<'query'>('taskWindow:links')
const ATTACHMENTS = makeFunctionReference<'query'>('taskWindow:attachments')

/* A registry whose root part answered. */
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
  const last = () => reports.at(-1)?.workspace
  return { s, parts, reports, last }
}

afterEach(() => {
  vi.useRealTimers()
  STALL.ms = 60_000
})

describe('the live parts registry', () => {
  it('reports the workspace held until the root answers, then complete with its rows', () => {
    const s = scripted()
    const reports: PartsReport[] = []
    createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
    )
    // a transition that brings no answer of the root holds the workspace
    s.send()
    expect(reports.at(-1)?.workspace).toEqual({ state: 'held' })
    serve(s)
    s.send()
    const w = reports.at(-1)?.workspace
    if (w?.state !== 'complete' || !w.value) throw new Error(`not complete: ${w?.state}`)
    expect(w.value.orgs.map((o) => o.id)).toEqual([ORG])
    expect(w.changed).toBe(true)
    // a transition that changes nothing of the root says so
    s.send([s.keyOf('inbox:summary', {})])
    expect(reports.at(-1)?.workspace).toMatchObject({ state: 'complete', changed: false })
  })

  it('completes from the root alone, subscribing nothing per organization', () => {
    const s = scripted()
    serve(s)
    const reports: PartsReport[] = []
    createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
    )
    s.send()
    const w = reports.at(-1)?.workspace
    if (w?.state !== 'complete' || !w.value) throw new Error(`not complete: ${w?.state}`)
    expect(w.value).not.toHaveProperty('issues')
    expect(w.value).not.toHaveProperty('projects')
    expect(w.value).not.toHaveProperty('access')
    expect(w.value).not.toHaveProperty('teamAccess')
    expect([...s.watched.keys()].filter((key) => key.includes(ORG))).toEqual([])
  })

  it('after a reconnect, holds the workspace until the root arrived again', async () => {
    const { s, last } = await started()
    expect(last()?.state).toBe('complete')
    s.reconnect()
    // the summary's transition on the new connection, with no root answer
    s.send([s.keyOf('inbox:summary', {})])
    expect(last()?.state).toBe('held')
    s.send([s.keyOf('workspace:root', ROOT_ARGS)])
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

  it('fails on a failed or refusing root, and Retry runs it again', async () => {
    const { s, parts, last } = await started()
    const rootKey = s.keyOf('workspace:root', ROOT_ARGS)
    s.set('workspace:root', ROOT_ARGS, { error: new Error('boom') })
    s.send([rootKey])
    expect(last()).toMatchObject({ state: 'failed' })
    s.set('workspace:root', ROOT_ARGS, { value: ROOT })
    // the failed run stays until the part is watched again
    s.send([rootKey])
    expect(last()).toMatchObject({ state: 'failed' })
    s.log.length = 0
    expect(parts.retry()).toBe(true)
    expect(s.log).toEqual([`stop ${rootKey}`, `watch ${rootKey}`])
    s.send([rootKey])
    expect(last()?.state).toBe('complete')
    // a refusal with a sentence fails it as one
    s.set('workspace:root', ROOT_ARGS, { value: { state: 'refused', message: 'Too much.' } })
    s.send([rootKey])
    const failed = last()
    expect(failed?.state === 'failed' && (failed.error as { data: unknown }).data).toEqual({
      code: 'rule',
      message: 'Too much.',
    })
    s.log.length = 0
    expect(parts.retry()).toBe(true)
    expect(s.log).toEqual([`stop ${rootKey}`, `watch ${rootKey}`])
    s.set('workspace:root', ROOT_ARGS, { value: ROOT })
    s.send([rootKey])
    expect(last()?.state).toBe('complete')
    // nothing failed, nothing to run again
    expect(parts.retry()).toBe(false)
  })

  it('reports no seat, and drops a seat that goes without holding the workspace', async () => {
    const { s, last } = await started()
    s.set('workspace:root', ROOT_ARGS, { value: { ...ROOT, orgs: [] } })
    s.send([s.keyOf('workspace:root', ROOT_ARGS)])
    const w = last()
    expect(w?.state === 'complete' && w.value?.orgs).toEqual([])
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
    s.set('workspace:root', ROOT_ARGS, { value: renamedRoot('Org 2') })
    s.send([thread, history, s.keyOf('workspace:root', ROOT_ARGS)])
    expect(reports).toHaveLength(count + 1)
    expect(reports.at(-1)?.sides).toEqual({
      thread: { value: { comments: ['c', 'd'] } },
      history: { value: { events: ['e'] } },
    })
    expect(last()).toMatchObject({ state: 'complete', changed: true })
    // a workspace transition alone tells of no side
    s.send([s.keyOf('workspace:root', ROOT_ARGS)])
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
    s.set('workspace:root', ROOT_ARGS, { value: renamedRoot('Org 2') })
    s.send([key(3), key(2), s.keyOf('workspace:root', ROOT_ARGS)])
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

  it('fails a workspace that stays incomplete with the root silent while online, and waits while offline', async () => {
    vi.useFakeTimers()
    STALL.ms = 1000
    const s = scripted()
    serve(s)
    let online = false
    const reports: PartsReport[] = []
    createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => online,
    )
    s.send()
    await vi.advanceTimersByTimeAsync(0)
    expect(reports.at(-1)?.workspace.state).toBe('complete')
    // after a reconnect the root stays silent
    s.reconnect()
    s.set('workspace:root', ROOT_ARGS, {})
    s.send([s.keyOf('workspace:root', ROOT_ARGS)])
    expect(reports.at(-1)?.workspace.state).toBe('held')
    await vi.advanceTimersByTimeAsync(5000)
    expect(reports.at(-1)?.workspace.state).toBe('held')
    online = true
    // the next check while online fails it
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
    const reports: PartsReport[] = []
    const parts = createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
    )
    parts.watchSide('thread', THREAD, { issue_id: 't' })
    s.send()
    await vi.advanceTimersByTimeAsync(0)
    expect(reports.at(-1)?.workspace.state).toBe('complete')
    // after a reconnect the root stays silent
    s.reconnect()
    s.set('workspace:root', ROOT_ARGS, {})
    s.send([s.keyOf('workspace:root', ROOT_ARGS)])
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

describe('the parts an organization subscribes', () => {
  it('watches no part of an organization, and joins the caller’s own rows from the root', async () => {
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
    const watched = s.log.filter((l) => l.startsWith('watch ')).map((l) => l.split('{')[0])
    expect(watched).not.toContain('watch workspace:people')
    expect(watched).not.toContain('watch workspace:catalog')
    expect(watched).not.toContain('watch workspace:inbox')
    // the feed waits for the desktop alert client, which watches it with a floor
    expect(watched).not.toContain('watch inbox:feed')
    expect(watched).not.toContain('watch workspace:projects')
    expect(new Set(watched)).toEqual(new Set(['watch workspace:root', 'watch inbox:summary']))
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
    const rootKey = s.keyOf('workspace:root', ROOT_ARGS)
    s.set('inbox:summary', {}, { value: { unread_count: 3 } })
    s.set('workspace:root', ROOT_ARGS, { value: renamedRoot('Renamed') })
    const count = reports.length
    s.send([summaryKey(s), rootKey])
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

describe('the view sides while the page is hidden', () => {
  const ITEM = makeFunctionReference<'query'>('inbox:item')
  const FEED = makeFunctionReference<'query'>('inbox:feed')
  const REFERENCE_ARGS = { org_id: ORG, ref: 'QN-1' }
  // every view side of one open task, with its query and arguments
  const VIEWS = [
    ['thread', THREAD, 'snapshot:threadComments', { org_id: ORG, issue_id: 't' }],
    ['history', HISTORY, 'snapshot:threadHistory', { org_id: ORG, issue_id: 't' }],
    ['task', TASK, 'taskWindow:task', { org_id: ORG, ref: 't' }],
    ['links', LINKS, 'taskWindow:links', { org_id: ORG, issue_id: 't' }],
    ['attachments', ATTACHMENTS, 'taskWindow:attachments', { org_id: ORG, issue_id: 't' }],
    ['reference', TASK, 'taskWindow:task', REFERENCE_ARGS],
    ['item', ITEM, 'inbox:item', { org_id: ORG, issue_id: 't' }],
  ] as const
  const viewKeys = (s: ReturnType<typeof scripted>) =>
    VIEWS.map(([, , name, args]) => s.keyOf(name, args))
  const watchViews = (parts: ReturnType<typeof createLiveParts>) => {
    for (const [side, ref, , args] of VIEWS) parts.watchSide(side, ref, args)
  }

  it('names every task window side and neither the summary nor the feed', () => {
    expect([...VIEW_SIDES].sort()).toEqual(VIEWS.map(([side]) => side).sort())
    expect(VIEW_SIDES).not.toContain('summary')
    expect(VIEW_SIDES).not.toContain('feed')
  })

  it('stops exactly the view sides, keeps their arguments, and subscribes each afresh on return', async () => {
    const { s, parts, reports } = await started()
    watchViews(parts)
    parts.watchSide('feed', FEED, { after: 5 })
    const feed = s.keyOf('inbox:feed', { after: 5 })
    const summary = s.keyOf('inbox:summary', {})
    s.log.length = 0
    parts.pauseViews(true)
    for (const key of viewKeys(s)) expect(s.watched.has(key)).toBe(false)
    expect(s.watched.has(summary)).toBe(true)
    expect(s.watched.has(feed)).toBe(true)
    expect(s.watched.has(s.keyOf('workspace:root', ROOT_ARGS))).toBe(true)
    for (const [side, , , args] of VIEWS) expect(parts.sideArgs(side)).toEqual(args)
    // a paused side has no failed run to run again
    expect(parts.rerunSide('item')).toBe(false)
    // the summary and the feed keep their news while the views pause
    s.set('inbox:summary', {}, { value: { unread_count: 2 } })
    s.set('inbox:feed', { after: 5 }, { value: { events: [] } })
    s.send([summary, feed])
    expect(reports.at(-1)?.sides).toEqual({
      summary: { value: { unread_count: 2 } },
      feed: { value: { events: [] } },
    })
    s.log.length = 0
    parts.pauseViews(false)
    expect(s.log).toEqual(viewKeys(s).map((key) => `watch ${key}`))
    // their news reaches the report as before
    s.set('snapshot:threadComments', VIEWS[0][3], { value: { comments: [] } })
    s.send([viewKeys(s)[0]])
    expect(reports.at(-1)?.sides).toEqual({ thread: { value: { comments: [] } } })
  })

  it('registers a watch while paused without subscribing, and a stop drops the registration', async () => {
    const { s, parts } = await started()
    parts.pauseViews(true)
    s.log.length = 0
    expect(parts.watchSide('thread', THREAD, VIEWS[0][3])).toBeUndefined()
    expect(parts.sideArgs('thread')).toEqual(VIEWS[0][3])
    parts.watchSide('history', HISTORY, VIEWS[1][3])
    parts.stopSide('history')
    expect(parts.sideArgs('history')).toBeUndefined()
    // the summary is no view side and subscribes while the views pause
    parts.stopSide('summary')
    parts.watchSide('summary', makeFunctionReference<'query'>('inbox:summary'), {})
    expect(s.log).toEqual([
      `stop ${s.keyOf('inbox:summary', {})}`,
      `watch ${s.keyOf('inbox:summary', {})}`,
    ])
    s.log.length = 0
    parts.pauseViews(false)
    expect(s.log).toEqual([`watch ${viewKeys(s)[0]}`])
  })

  it('moves a paused reference registration to the side that reads its arguments', async () => {
    const { s, parts } = await started()
    parts.pauseViews(true)
    parts.watchSide('reference', TASK, REFERENCE_ARGS)
    parts.watchSide('task', TASK, REFERENCE_ARGS)
    expect(parts.sideArgs('reference')).toBeUndefined()
    s.log.length = 0
    parts.pauseViews(false)
    // one subscription, the task side's
    expect(s.log).toEqual([`watch ${s.keyOf('taskWindow:task', REFERENCE_ARGS)}`])
    expect(parts.sideArgs('task')).toEqual(REFERENCE_ARGS)
  })

  it('subscribes no view side of a registry created paused, the address read included, until the return', async () => {
    const s = scripted()
    serve(s)
    const reports: PartsReport[] = []
    const parts = createLiveParts(
      s.live,
      (r) => reports.push(r),
      () => true,
      { address: { slug: 'org', ref: 'QN-1' }, paused: true },
    )
    s.set('workspace:root', ROOT_ARGS, {
      value: { ...ROOT, orgs: [{ ...ROOT.orgs[0], slug: 'org' }] },
    })
    s.send()
    await tick()
    watchViews(parts)
    expect(reports.at(-1)?.workspace.state).toBe('complete')
    for (const key of viewKeys(s)) expect(s.watched.has(key)).toBe(false)
    expect(parts.sideArgs('reference')).toEqual(REFERENCE_ARGS)
    expect(s.watched.has(s.keyOf('inbox:summary', {}))).toBe(true)
    parts.pauseViews(false)
    for (const key of viewKeys(s)) expect(s.watched.has(key)).toBe(true)
  })

  it('drops the registrations with the registry', async () => {
    const { s, parts } = await started()
    watchViews(parts)
    parts.pauseViews(true)
    parts.stop()
    parts.pauseViews(false)
    expect([...s.watched.keys()]).toEqual([])
  })
})
