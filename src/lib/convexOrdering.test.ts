import { ConvexClient } from 'convex/browser'
import { anyApi } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLiveQueries } from './liveQueries'

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

  it('tells every handler of a transition that changed nothing', async () => {
    const { live, seen, transition } = await start()
    // a handler that runs after the first one
    const later: string[][] = []
    live.onTransition((t) => later.push([...t.tokens]))
    transition([])
    expect(seen.at(-1)?.tokens).toEqual([])
    expect(later).toEqual([[]])
  })

  it('after the socket reconnects, names every watched query again with the next connection count, unchanged values included', async () => {
    const { list, count, socket, seen } = await start()
    // The client reconnects after a jittered backoff of 0.5 to 1.5 s. Fake
    // timers spend the same 2 s budget in 20 ms steps without real waiting.
    // Date and performance, which the client and the transport read, stay
    // real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let again = ScriptedSocket.last
    try {
      // the server drops the socket
      socket.readyState = 3
      socket.onclose?.({ code: 1011, reason: 'gone' })
      for (let i = 0; i < 100 && (again === socket || again?.readyState !== 1); i++) {
        await vi.advanceTimersByTimeAsync(20)
        again = ScriptedSocket.last
      }
    } finally {
      // Drops every fake timer still pending. After a reconnect that is the
      // client's 60 s server inactivity timer, which close() in afterEach
      // would clear anyway. Without one it is the reconnect or the new
      // socket's open, so the checks below fail.
      vi.useRealTimers()
    }
    expect(again).not.toBe(socket)
    expect(again?.readyState, 'the new socket is open').toBe(1)
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

  it('never reads the old result for a subscription made after the last one stopped', async () => {
    const { live, list, socket, seen, transition } = await start()
    list.stop()
    const again = live.watch(anyApi.tasks.list, {})
    expect(again.token).toBe(list.token)
    // it joined no answered subscription, so the result the client still
    // holds by this token is the old run's (lib/liveView.ts takes none)
    expect(again.joined).toBe(false)
    expect(live.read(again.token)).toBe('list 1')
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

  it('says a watch joined a subscription whose result arrived, which it reads at once', async () => {
    const { live, list, count, transition } = await start()
    // the same query and arguments share the running subscription
    const beside = live.watch(anyApi.tasks.list, {})
    expect(beside).toMatchObject({ token: list.token, joined: true })
    expect(live.read(beside.token)).toBe('list 1')
    // one that has not answered yet is no join
    const other = live.watch(anyApi.tasks.other, {})
    const second = live.watch(anyApi.tasks.other, {})
    expect([other.joined, second.joined]).toEqual([false, false])
    beside.stop()
    // a stop that leaves another watch keeps the subscription answered
    expect(live.watch(anyApi.tasks.list, {}).joined).toBe(true)
    transition([{ queryId: 1, value: 5 }])
    expect(live.watch(anyApi.tasks.count, {})).toMatchObject({ token: count.token, joined: true })
  })
})
