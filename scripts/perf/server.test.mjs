import { afterEach, describe, expect, it, vi } from 'vitest'

/* The browser benchmark's stand-in server (scripts/perf/server.mjs), loaded
   as its worker would be, with the page's parameters as the worker's name. */

/** Loads the server for page parameters `params` and answers what it posts
    and a way to send it a message. */
async function server(params) {
  vi.resetModules()
  const posted = []
  vi.stubGlobal('self', { name: params, postMessage: (message) => posted.push(message) })
  await import('./server.mjs')
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
      args: { id: '00000004-0000-4000-8000-000000000001', patch: { status: 'todo' } },
    })
    const order = posted.filter((m) => m.type !== 'state').map((m) => m.id ?? m.type)
    expect(order.slice(0, 2)).toEqual(['result', 'write'])
  }, 60_000)

  it('answers writes in the order they came', async () => {
    const { posted, send } = await server('tasks=20&latency=0&mbps=1')
    await send({ type: 'subscribe', id: 's', name: 'snapshot:forMe', args: {} })
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'result')).toBe(true), 30_000)
    posted.length = 0
    const task = '00000004-0000-4000-8000-000000000001'
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

  it('answers a scenario that fails with its failure', async () => {
    const { posted, send } = await server('tasks=20&latency=0&mbps=100000')
    // no comment thread is open
    await send({ type: 'scenario', id: 'comments', name: 'deliverComments', args: [] })
    expect(posted.find((m) => m.id === 'comments').failure).toContain('one open comment thread')
  })
})
