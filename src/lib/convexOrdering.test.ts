import { ConvexClient } from 'convex/browser'
import { anyApi } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ConnectionChange, createLiveQueries } from './liveQueries'

/* The store's optimistic layers (store/planner.ts send) rely on three things
   the Convex client does, pinned here against a real ConvexClient driving a
   scripted socket. Check them again on every Convex upgrade.

   1. A Transition that holds an accepted write runs the query listeners
      before the write's promise resolves, so an answer's handler sees every
      delivery that holds it.
   2. A refused write resolves on its own response, with no query change.
   3. A new listener on a query the client already holds gets the very
      object the earlier listener got, on a 0 ms timer, also right after the
      only listener left, so the store can tell a replay from a delivery by
      identity. */

type Sent = { type: string; requestId?: number; newVersion?: number; [key: string]: unknown }

/** A WebSocket double that opens on the next task, records what the client
    sends and lets the test answer as the server. */
class ScriptedSocket {
  static last: ScriptedSocket | null = null
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readyState = 0
  sent: Sent[] = []
  constructor(readonly url: string) {
    ScriptedSocket.last = this
    setTimeout(() => {
      this.readyState = 1
      this.onopen?.({})
    }, 0)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.readyState = 3
    setTimeout(() => this.onclose?.({ code: 1000, reason: '' }), 0)
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

/** A server timestamp as the protocol carries it: a little-endian u64 in base64. */
function u64(n: number) {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(n), true)
  return btoa(String.fromCharCode(...bytes))
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('Convex client ordering the store relies on', () => {
  let client: ConvexClient | null = null

  afterEach(async () => {
    await client?.close()
    client = null
  })

  /** Starts a client with one subscription to tasks:list, delivered once
      with 'first'. Answers the socket, the events in order, and a way to
      deliver the next value as the server would. */
  async function start() {
    client = new ConvexClient('https://happy-otter-123.convex.cloud', {
      webSocketConstructor: ScriptedSocket as unknown as typeof WebSocket,
      unsavedChangesWarning: false,
    })
    const events: string[] = []
    const values: unknown[] = []
    const stop = client.onUpdate(anyApi.tasks.list, {}, (value) => {
      values.push(value)
      events.push(`listener:${JSON.stringify(value)}`)
    })
    await tick()
    await tick()
    const socket = ScriptedSocket.last!
    const querySet = socket.sent.find((m) => m.type === 'ModifyQuerySet')!.newVersion!
    let ts = 0
    const deliver = (value: unknown) => {
      socket.receive({
        type: 'Transition',
        startVersion: { querySet, ts: u64(ts), identity: 0 },
        endVersion: { querySet, ts: u64(++ts), identity: 0 },
        modifications: [{ type: 'QueryUpdated', queryId: 0, value, logLines: [], journal: null }],
      })
    }
    // the first transition moves the query set from version 0
    socket.receive({
      type: 'Transition',
      startVersion: { querySet: 0, ts: u64(0), identity: 0 },
      endVersion: { querySet, ts: u64(++ts), identity: 0 },
      modifications: [
        { type: 'QueryUpdated', queryId: 0, value: 'first', logLines: [], journal: null },
      ],
    })
    const nextTs = () => ts + 1
    return { socket, events, values, deliver, nextTs, stop }
  }

  it('runs the listener of a delivery that holds a write before the write resolves', async () => {
    const { socket, events, deliver, nextTs } = await start()
    const done = client!.mutation(anyApi.tasks.rename, {}).then(() => events.push('resolved'))
    await tick()
    const request = socket.sent.find((m) => m.type === 'Mutation')!
    socket.receive({
      type: 'MutationResponse',
      requestId: request.requestId,
      success: true,
      result: null,
      ts: u64(nextTs()),
      logLines: [],
    })
    await tick()
    // accepted, but no delivery holds it yet
    expect(events).toEqual(['listener:"first"'])
    deliver('second')
    await done
    expect(events).toEqual(['listener:"first"', 'listener:"second"', 'resolved'])
  })

  it('resolves a refused write on its own response without a delivery', async () => {
    const { socket, events } = await start()
    const done = client!.mutation(anyApi.tasks.rename, {}).then(
      () => events.push('resolved'),
      () => events.push('refused'),
    )
    await tick()
    const request = socket.sent.find((m) => m.type === 'Mutation')!
    socket.receive({
      type: 'MutationResponse',
      requestId: request.requestId,
      success: false,
      result: 'no write access',
      logLines: [],
    })
    await done
    expect(events).toEqual(['listener:"first"', 'refused'])
  })

  it('hands the held object again to a listener that resubscribes at once', async () => {
    const { values, deliver, stop } = await start()
    deliver({ rows: [3] })
    // the store's pattern on Try again: drop its one listener, subscribe again
    stop()
    const replayed: unknown[] = []
    client!.onUpdate(anyApi.tasks.list, {}, (value) => replayed.push(value))
    expect(replayed).toEqual([])
    await tick()
    expect(replayed).toHaveLength(1)
    expect(replayed[0]).toBe(values[values.length - 1])
  })

  it('hands a new listener the object the earlier listener got, on a timer', async () => {
    const { values, deliver } = await start()
    deliver({ rows: [1, 2] })
    const replayed: unknown[] = []
    client!.onUpdate(anyApi.tasks.list, {}, (value) => replayed.push(value))
    expect(replayed).toEqual([])
    await tick()
    expect(replayed).toHaveLength(1)
    expect(replayed[0]).toBe(values[values.length - 1])
  })
})

/* lib/liveQueries.ts reads the base client by transition. These pin what it
   relies on, against the same scripted socket. */
describe('live queries over the base client', () => {
  let client: ConvexClient | null = null

  afterEach(async () => {
    await client?.close()
    client = null
  })

  /** A client with tasks:list and tasks:count watched through the
      transport, both answered in one first transition. */
  async function start() {
    client = new ConvexClient('https://happy-otter-123.convex.cloud', {
      webSocketConstructor: ScriptedSocket as unknown as typeof WebSocket,
      unsavedChangesWarning: false,
      onServerDisconnectError: (message) => live.serverClosed(message),
    })
    const live = createLiveQueries(client.client, (ref, args) => client!.query(ref, args))
    const seen: { tokens: string[]; values: unknown[]; connection: number }[] = []
    live.onTransition((t) =>
      seen.push({
        tokens: [...t.tokens],
        values: [...t.tokens].map((token) => live.read(token)),
        connection: t.connection,
      }),
    )
    const list = live.watch(anyApi.tasks.list, {})
    const count = live.watch(anyApi.tasks.count, {})
    await tick()
    await tick()
    const socket = ScriptedSocket.last!
    // the query set version the client asked for last, which a transition
    // moves the server to
    const latest = () =>
      Math.max(...socket.sent.filter((m) => m.type === 'ModifyQuerySet').map((m) => m.newVersion!))
    let ts = 0
    let version = 0
    const transition = (modifications: { queryId: number; value?: unknown; removed?: true }[]) => {
      const from = version
      version = latest()
      socket.receive({
        type: 'Transition',
        startVersion: { querySet: from, ts: u64(ts), identity: 0 },
        endVersion: { querySet: version, ts: u64(++ts), identity: 0 },
        modifications: modifications.map((m) =>
          m.removed
            ? { type: 'QueryRemoved', queryId: m.queryId }
            : {
                type: 'QueryUpdated',
                queryId: m.queryId,
                value: m.value,
                logLines: [],
                journal: null,
              },
        ),
      })
    }
    transition([
      { queryId: 0, value: 'list 1' },
      { queryId: 1, value: 3 },
    ])
    return { live, list, count, socket, seen, transition, nextTs: () => ts + 1 }
  }

  it('calls the handler once per transition, naming only the queries that changed', async () => {
    const { list, count, seen, transition } = await start()
    expect(seen).toEqual([
      { tokens: [list.token, count.token], values: ['list 1', 3], connection: 1 },
    ])
    transition([{ queryId: 1, value: 4 }])
    expect(seen.at(-1)).toEqual({ tokens: [count.token], values: [4], connection: 1 })
  })

  it('tells of a transition that changed nothing, and drops a refused write', async () => {
    const { seen, transition, socket } = await start()
    transition([])
    expect(seen.at(-1)?.tokens).toEqual([])
    const before = seen.length
    const done = client!.mutation(anyApi.tasks.rename, {}).catch(() => 'refused')
    await tick()
    const request = socket.sent.find((m) => m.type === 'Mutation')!
    socket.receive({
      type: 'MutationResponse',
      requestId: request.requestId,
      success: false,
      result: 'no write access',
      logLines: [],
    })
    expect(await done).toBe('refused')
    expect(seen).toHaveLength(before)
  })

  it('after the socket reconnects, names every watched query again with the next connection count, unchanged values included', async () => {
    const { list, count, socket, seen } = await start()
    // the server drops the socket
    socket.readyState = 3
    socket.onclose?.({ code: 1011, reason: 'gone' })
    let again = ScriptedSocket.last
    for (let i = 0; i < 100 && (again === socket || again?.readyState !== 1); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      again = ScriptedSocket.last
    }
    expect(again).not.toBe(socket)
    await tick()
    // the new connection asks for every query again, from an empty set
    const ask = again!.sent.filter((m) => m.type === 'ModifyQuerySet').at(-1)!
    const before = seen.length
    again!.receive({
      type: 'Transition',
      startVersion: { querySet: 0, ts: u64(0), identity: 0 },
      endVersion: { querySet: ask.newVersion, ts: u64(100), identity: 0 },
      modifications: [0, 1].map((queryId) => ({
        type: 'QueryUpdated',
        queryId,
        value: queryId === 0 ? 'list 1' : 3,
        logLines: [],
        journal: null,
      })),
    })
    expect(seen.length).toBe(before + 1)
    expect(seen.at(-1)).toEqual({
      tokens: [list.token, count.token],
      values: ['list 1', 3],
      connection: 2,
    })
  })

  it('tells of a drop for the server’s load before it reconnects, and the next connection asks only for what is still watched', async () => {
    const { live, count, socket } = await start()
    const changes: ConnectionChange[] = []
    // store/liveParts.ts stops the parts beyond a wave when it hears of a drop
    live.onConnection((change) => {
      changes.push(change)
      if (!change.connected) count.stop()
    })
    vi.useFakeTimers()
    try {
      socket.readyState = 3
      socket.onclose?.({
        code: 1013,
        reason: 'TooManyConcurrentRequests: Too many concurrent requests.',
      })
      await Promise.resolve()
      expect(changes).toEqual([{ connected: false, overloaded: true }])
      // Convex waits 3 s, give or take half, before it connects again
      await vi.advanceTimersByTimeAsync(5000)
      const again = ScriptedSocket.last!
      expect(again).not.toBe(socket)
      expect(changes.at(-1)).toEqual({ connected: true, overloaded: false })
      const ask = again.sent.filter((m) => m.type === 'ModifyQuerySet')
      expect(
        ask.flatMap((m) => (m.modifications as { udfPath: string }[]).map((x) => x.udfPath)),
      ).toEqual(['tasks:list'])
      // a drop for any other reason is no sign of load
      again.readyState = 3
      again.onclose?.({ code: 1011, reason: 'InternalServerError: gone' })
      await Promise.resolve()
      expect(changes.at(-1)).toEqual({ connected: false, overloaded: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts a close for the server’s load only for the connection it closed', async () => {
    const { live, socket } = await start()
    vi.useFakeTimers()
    try {
      // closed for its load before anything listens, as while the store boots
      socket.readyState = 3
      socket.onclose?.({ code: 1013, reason: 'TooManyConcurrentRequests: Too many requests.' })
      await vi.advanceTimersByTimeAsync(5000)
      const changes: ConnectionChange[] = []
      live.onConnection((change) => changes.push(change))
      const again = ScriptedSocket.last!
      expect(again).not.toBe(socket)
      // a lost network on the next connection explains nothing
      again.readyState = 3
      again.onclose?.({ code: 1006, reason: '' })
      await Promise.resolve()
      expect(changes).toEqual([{ connected: false, overloaded: false }])
      await vi.advanceTimersByTimeAsync(10_000)
      // nor does a reason that only mentions the code
      const third = ScriptedSocket.last!
      expect(third).not.toBe(again)
      third.readyState = 3
      third.onclose?.({ code: 1011, reason: 'InternalServerError: after 1013 earlier' })
      await Promise.resolve()
      expect(changes.at(-1)).toEqual({ connected: false, overloaded: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('never reads the old result for a subscription made after the last one stopped', async () => {
    const { live, list, socket, seen, transition } = await start()
    list.stop()
    const again = live.watch(anyApi.tasks.list, {})
    expect(again.token).toBe(list.token)
    await tick()
    // the client asks the server for it under a new query id
    const adds = socket.sent
      .filter((m) => m.type === 'ModifyQuerySet')
      .flatMap((m) => (m.modifications as { type: string; queryId: number }[]) ?? [])
      .filter((m) => m.type === 'Add')
    expect(adds.map((m) => m.queryId)).toEqual([0, 1, 2])
    // The client holds the old run's result only until the next transition,
    // and names the query again only when the new run's result arrives, so
    // the transport, which reads a query only when a transition names it,
    // never reads the old run's (store/liveParts.ts Retry relies on it).
    transition([])
    expect(seen.at(-1)?.tokens).toEqual([])
    expect(live.read(again.token)).toBeUndefined()
    transition([{ queryId: 0, removed: true }])
    expect(seen.at(-1)?.tokens).toEqual([])
    transition([{ queryId: 2, value: 'list 2' }])
    expect(seen.at(-1)).toMatchObject({ tokens: [again.token], values: ['list 2'] })
  })
})
