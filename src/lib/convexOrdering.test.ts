import { ConvexClient } from 'convex/browser'
import { anyApi } from 'convex/server'
import { afterEach, describe, expect, it } from 'vitest'

/* The store's optimistic layers (store/planner.ts send) rely on three things
   the Convex client does, pinned here against a real ConvexClient driving a
   scripted socket. Check them again on every Convex upgrade.

   1. A Transition that holds an accepted write runs the query listeners
      before the write's promise resolves, so an answer's handler sees every
      delivery that holds it.
   2. A refused write resolves on its own response, with no query change.
   3. A new listener on a query the client already holds gets the very
      object the earlier listener got, on a 0 ms timer, so the store can tell
      a replay from a delivery by identity. */

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
    client.onUpdate(anyApi.tasks.list, {}, (value) => {
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
    return { socket, events, values, deliver, nextTs }
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
