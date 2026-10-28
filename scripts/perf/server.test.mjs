import { afterEach, describe, expect, it, vi } from 'vitest'
import { idWindows, startWindows } from '../../convex/lib/idWindows'

/* The browser benchmark's stand-in server (scripts/perf/server.mjs), loaded
   as its worker would be, with the page's parameters as the worker's name. */

/* The id of the stand-in workspace's first task (server.mjs id). */
let TASK_1 = ''

/** Loads the server for page parameters `params` and answers what it posts
    and a way to send it a message. */
async function server(params) {
  vi.resetModules()
  const posted = []
  vi.stubGlobal('self', { name: params, postMessage: (message) => posted.push(message) })
  const { id } = await import('./server.mjs')
  TASK_1 = id('4', 1)
  const send = (data) => self.onmessage({ data })
  return { posted, send }
}

/** The snapshot the server answers a query with. */
async function snapshotOf(params) {
  const { posted, send } = await server(`latency=0&mbps=100000&${params}`)
  await send({ type: 'query', id: 'q', name: 'snapshot:forMe', args: {} })
  const result = posted.find((message) => message.type === 'result')
  return { snapshot: JSON.parse(result.text), bytes: result.bytes, text: result.text }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the benchmark server', () => {
  it('makes as many links, attachments and follows as each share asks', async () => {
    const dense = await snapshotOf('tasks=100&links=1&attachments=0.5&follows=0.5')
    expect(dense.snapshot.links.length).toBeGreaterThan(90)
    expect(dense.snapshot.attachments).toHaveLength(50)
    expect(dense.snapshot.issueSubs).toHaveLength(50)
    const usual = await snapshotOf('tasks=100')
    expect(usual.snapshot.attachments).toHaveLength(10)
    // shares that are no reciprocal of a whole number
    const odd = await snapshotOf('tasks=100&attachments=0.4&follows=0.7')
    expect(odd.snapshot.attachments).toHaveLength(40)
    expect(odd.snapshot.issueSubs).toHaveLength(70)
  })

  it('counts the UTF-8 bytes it sends', async () => {
    const { bytes, text } = await snapshotOf('tasks=20')
    // the workspace holds names past ASCII, so the two counts differ
    expect(text.length).toBeLessThan(Buffer.byteLength(text))
    expect(bytes).toBe(Buffer.byteLength(text))
    const { utf8 } = await import('./server.mjs')
    for (const sample of ['Ship 🚀', 'åäö', '日本', 'plain'])
      expect(utf8(sample), sample).toBe(Buffer.byteLength(sample))
  })

  it('answers a write that changes nothing only after the results before it', async () => {
    // 1 Mbps, so a result takes long enough to be on its way
    const { posted, send } = await server('tasks=20&latency=0&mbps=1')
    await send({ type: 'subscribe', id: 's', name: 'snapshot:forMe', args: {} })
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'result')).toBe(true), 30_000)
    posted.length = 0
    // another person's rename, whose result is on its way when the write
    // comes, and a write of the status task 1 has already
    void send({ type: 'scenario', id: 'rename', name: 'deliverRemote', args: [0] })
    await send({
      type: 'mutation',
      id: 'write',
      name: 'issues:update',
      args: { id: TASK_1, patch: { status: 'todo' } },
    })
    const order = posted.filter((m) => m.type !== 'state').map((m) => m.id ?? m.type)
    expect(order.slice(0, 2)).toEqual(['result', 'write'])
  }, 60_000)

  it('answers writes in the order they came', async () => {
    const { posted, send } = await server('tasks=20&latency=0&mbps=1')
    await send({ type: 'subscribe', id: 's', name: 'snapshot:forMe', args: {} })
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'result')).toBe(true), 30_000)
    posted.length = 0
    const task = TASK_1
    // a write that changes the task, then one that changes nothing
    const changing = send({
      type: 'mutation',
      id: 'changing',
      name: 'issues:update',
      args: { id: task, patch: { title: 'Renamed' } },
    })
    const same = send({
      type: 'mutation',
      id: 'same',
      name: 'issues:update',
      args: { id: task, patch: { status: 'todo' } },
    })
    await Promise.all([changing, same])
    const order = posted.filter((m) => m.type !== 'state').map((m) => m.id ?? m.type)
    expect(order).toEqual(['result', 'changing', 'same'])
  }, 60_000)

  it('fails a read it cannot answer and goes on with the rest', async () => {
    const { posted, send } = await server('tasks=20&latency=0&mbps=100000')
    await send({ type: 'query', id: 'unknown', name: 'files:nothing', args: {} })
    await send({ type: 'query', id: 'known', name: 'snapshot:forMe', args: {} })
    const unknown = posted.find((m) => m.to === 'unknown')
    expect(unknown.error).toContain('Unimplemented benchmark query')
    expect(posted.find((m) => m.to === 'known').text).toBeTruthy()
  })

  it("answers the task window's comment page and, apart, its history page", async () => {
    const { posted, send } = await server('tasks=20&latency=0&mbps=100000')
    const args = { issue_id: TASK_1 }
    await send({ type: 'query', id: 'comments', name: 'snapshot:threadComments', args })
    await send({ type: 'query', id: 'history', name: 'snapshot:threadHistory', args })
    const answer = (id) => JSON.parse(posted.find((m) => m.to === id).text)
    expect(Object.keys(answer('comments')).sort()).toEqual(['comments', 'earlier'])
    expect(answer('history')).toEqual({ events: [], earlier: false, next: null })
  })

  it('answers the appearance mode the page asks for, dark unless it asks for light', async () => {
    const modeOf = async (params) => {
      const { posted, send } = await server(`tasks=20&latency=0&mbps=100000${params}`)
      await send({ type: 'query', id: 'appearance', name: 'appearance:get', args: {} })
      return JSON.parse(posted.find((m) => m.to === 'appearance').text).mode
    }
    expect(await modeOf('&appearance=light')).toBe('light')
    expect(await modeOf('')).toBe('dark')
    expect(await modeOf('&appearance=sepia')).toBe('dark')
  })

  it('answers a scenario that fails with its failure', async () => {
    const { posted, send } = await server('tasks=20&latency=0&mbps=100000')
    // no comment thread is open
    await send({ type: 'scenario', id: 'comments', name: 'deliverComments', args: [] })
    expect(posted.find((m) => m.id === 'comments').failure).toContain('one open comment thread')
  })

  it("answers a write once its own results are in, not a later write's", async () => {
    const { posted, send } = await server('tasks=20&latency=0&mbps=1')
    await send({ type: 'subscribe', id: 's', name: 'snapshot:forMe', args: {} })
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'result')).toBe(true), 30_000)
    posted.length = 0
    const task = TASK_1
    const first = send({
      type: 'mutation',
      id: 'first',
      name: 'issues:update',
      args: { id: task, patch: { title: 'First' } },
    })
    // the second write comes while the first one's result is on its way
    const second = send({
      type: 'mutation',
      id: 'second',
      name: 'issues:update',
      args: { id: task, patch: { title: 'Second' } },
    })
    await Promise.all([first, second])
    const order = posted.filter((m) => m.type !== 'state').map((m) => m.id ?? m.type)
    expect(order).toEqual(['result', 'first', 'result', 'second'])
  }, 60_000)

  it('serves the workspace in parts and re-sends only the window a remote rename changed, in one transition', async () => {
    const { posted, send } = await server('tasks=500&latency=0&mbps=100000')
    await send({ type: 'query', id: 'root', name: 'workspace:root', args: {} })
    const [org] = JSON.parse(posted.find((m) => m.to === 'root').text).orgs
    const windows = idWindows(startWindows(org).tasks)
    expect(windows.length).toBeGreaterThan(2)
    for (const [i, w] of windows.entries())
      send({ type: 'watch', id: `w${i}`, name: 'workspace:tasks', args: { org_id: org.id, ...w } })
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'transition')).toBe(true))
    const first = posted.filter((m) => m.type === 'transition')
    expect(first).toHaveLength(1)
    expect(first[0].results).toHaveLength(windows.length)
    const issues = first[0].results.flatMap((r) => JSON.parse(r.text).issues)
    expect(issues.length).toBeGreaterThan(400)
    expect(issues).toHaveLength(new Set(issues.map((i) => i.id)).size)
    posted.length = 0
    await send({ type: 'scenario', id: 'rename', name: 'deliverRemote', args: [250] })
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'transition')).toBe(true))
    const [change] = posted.filter((m) => m.type === 'transition')
    expect(change.results).toHaveLength(1)
  })
})
