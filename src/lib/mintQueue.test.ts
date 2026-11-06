import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMintQueue, MINT_QUEUE, type MintCall, type MintRequest } from './mintQueue'

const BOUNDS = structuredClone(MINT_QUEUE)

class Refusal extends Error {}

type Call = {
  org: string
  kind: 'attachment' | 'avatar'
  ids: string[]
  resolve: (answer?: Partial<Awaited<ReturnType<MintCall>>>) => void
  /** answers exactly `value`, as a stand-in that answers nothing might */
  raw: (value: unknown) => void
  reject: (error: unknown) => void
}

/* A queue over a stand-in mint that records each call and leaves it
   waiting until the test answers it. */
function harness() {
  const calls: Call[] = []
  let running = 0
  let most = 0
  const mint: MintCall = (org, ids) => {
    running++
    most = Math.max(most, running)
    return new Promise((resolve, reject) => {
      const done = () => {
        running--
      }
      calls.push({
        org,
        kind: ids.attachment_ids ? 'attachment' : 'avatar',
        ids: ids.attachment_ids ?? ids.profile_ids ?? [],
        resolve: (answer = {}) => {
          done()
          resolve({ attachments: {}, avatars: {}, ...answer })
        },
        raw: (value) => {
          done()
          resolve(value as Awaited<ReturnType<MintCall>>)
        },
        reject: (error) => {
          done()
          reject(error)
        },
      })
    })
  }
  const queue = createMintQueue(mint, { refused: (e) => e instanceof Refusal })
  return { calls, queue, most: () => most }
}

/* A lease for every id of `call`. */
const leases = (call: Call) =>
  Object.fromEntries(call.ids.map((id) => [id, { url: `https://files.test/${id}`, exp: 1 }]))

/* Answers `call` with a lease for each of its ids. */
function answer(call: Call) {
  call.resolve(
    call.kind === 'attachment' ? { attachments: leases(call) } : { avatars: leases(call) },
  )
}

const item = (kind: MintRequest['kind'], i: number, org = 'org-a'): MintRequest => ({
  kind,
  id: `${kind}-${i}`,
  org,
  key: `${kind}:${i}`,
})

const flush = () => vi.advanceTimersByTimeAsync(0)

describe('the mint queue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    Object.assign(MINT_QUEUE, structuredClone(BOUNDS))
  })

  it('sends 250 attachments asked in one task as 100, 100 and 50, two calls at once', async () => {
    const h = harness()
    const answers = Array.from({ length: 250 }, (_, i) => h.queue.request(item('attachment', i)))
    expect(h.calls).toHaveLength(0)
    await flush()
    expect(h.calls.map((c) => c.ids.length)).toEqual([100, 100])
    answer(h.calls[0] as Call)
    await flush()
    expect(h.calls.map((c) => c.ids.length)).toEqual([100, 100, 50])
    answer(h.calls[1] as Call)
    answer(h.calls[2] as Call)
    const outcomes = await Promise.all(answers)
    expect(outcomes.every((o) => o.state === 'lease')).toBe(true)
    expect(h.most()).toBe(2)
    expect(new Set(h.calls.flatMap((c) => c.ids)).size).toBe(250)
  })

  it('sends 1,000 pictures as ten calls of 100', async () => {
    const h = harness()
    const answers = Array.from({ length: 1000 }, (_, i) => h.queue.request(item('avatar', i)))
    for (let sent = 0; sent < 10; sent++) {
      await flush()
      const open = h.calls.filter((c) => !('done' in c))
      for (const call of open.slice(-2)) {
        answer(call)
        Object.assign(call, { done: true })
      }
    }
    await Promise.all(answers)
    expect(h.calls).toHaveLength(10)
    expect(h.calls.every((c) => c.ids.length === 100 && c.kind === 'avatar')).toBe(true)
    expect(h.most()).toBe(2)
  })

  it('sends attachments asked after pictures before the waiting pictures', async () => {
    const h = harness()
    for (let i = 0; i < 300; i++) void h.queue.request(item('avatar', i))
    await flush()
    expect(h.calls.map((c) => c.kind)).toEqual(['avatar', 'avatar'])
    void h.queue.request(item('attachment', 1))
    answer(h.calls[0] as Call)
    await flush()
    expect(h.calls.map((c) => c.kind)).toEqual(['avatar', 'avatar', 'attachment'])
  })

  it('never mixes kinds or organizations in one call', async () => {
    MINT_QUEUE.inFlight = 10
    const h = harness()
    for (let i = 0; i < 3; i++) {
      void h.queue.request(item('attachment', i, 'org-a'))
      void h.queue.request(item('attachment', 10 + i, 'org-b'))
      void h.queue.request(item('avatar', i, 'org-a'))
    }
    await flush()
    expect(h.calls.map((c) => [c.kind, c.org, c.ids.length])).toEqual([
      ['attachment', 'org-a', 3],
      ['attachment', 'org-b', 3],
      ['avatar', 'org-a', 3],
    ])
  })

  it('shares a repeated key’s answer, and sends an id two keys name once', async () => {
    const h = harness()
    const first = h.queue.request(item('attachment', 1))
    const again = h.queue.request(item('attachment', 1))
    expect(again).toBe(first)
    const older = h.queue.request({ kind: 'avatar', id: 'p', org: 'org-a', key: 'avatar:p:v1' })
    const newer = h.queue.request({ kind: 'avatar', id: 'p', org: 'org-a', key: 'avatar:p:v2' })
    await flush()
    expect(h.calls.map((c) => c.ids)).toEqual([['attachment-1'], ['p']])
    // on its way, it still shares
    expect(h.queue.request(item('attachment', 1))).toBe(first)
    answer(h.calls[0] as Call)
    answer(h.calls[1] as Call)
    expect((await older).state).toBe('lease')
    expect((await newer).state).toBe('lease')
  })

  it('answers missing for an omitted id, refused for its own refused call only, failed otherwise', async () => {
    MINT_QUEUE.batch = 2
    const h = harness()
    const [a, b, c, d, e] = [0, 1, 2, 3, 4].map((i) => h.queue.request(item('attachment', i)))
    await flush()
    const [first, second] = h.calls as [Call, Call]
    first.resolve({ attachments: { 'attachment-0': { url: 'u', exp: 1 } } })
    second.reject(new Refusal('forbidden'))
    await flush()
    ;(h.calls[2] as Call).reject(new Error('socket closed'))
    expect(await Promise.all([a, b, c, d, e])).toEqual([
      { state: 'lease', lease: { url: 'u', exp: 1 } },
      { state: 'missing' },
      { state: 'refused' },
      { state: 'refused' },
      { state: 'failed' },
    ])
  })

  it('answers a call whose answer holds no leases failed, never missing', async () => {
    const h = harness()
    const asked = h.queue.request(item('avatar', 0))
    await flush()
    ;(h.calls[0] as Call).raw(null)
    expect(await asked).toEqual({ state: 'failed' })
    // its slot is free again
    const next = h.queue.request(item('avatar', 1))
    await flush()
    answer(h.calls[1] as Call)
    expect((await next).state).toBe('lease')
  })

  it('answers a timed-out call failed at 15 s and keeps its slot until it settles', async () => {
    MINT_QUEUE.batch = 1
    const h = harness()
    const stuck = h.queue.request(item('avatar', 0))
    void h.queue.request(item('avatar', 1))
    const third = h.queue.request(item('avatar', 2))
    await flush()
    expect(h.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(14_999)
    let settled = false
    void stuck.then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await stuck).toEqual({ state: 'failed' })
    // both slots are still held, so the third waits
    expect(h.calls).toHaveLength(2)
    answer(h.calls[0] as Call)
    await flush()
    expect(h.calls).toHaveLength(3)
    expect(h.calls[2]?.ids).toEqual(['avatar-2'])
    answer(h.calls[2] as Call)
    expect((await third).state).toBe('lease')
    // the late answer of the timed-out call changes nothing
    expect(await stuck).toEqual({ state: 'failed' })
  })

  it('drops the answers on their way and the waiting requests when cleared', async () => {
    MINT_QUEUE.batch = 1
    MINT_QUEUE.inFlight = 1
    const h = harness()
    const sent = h.queue.request(item('attachment', 0))
    const queued = h.queue.request(item('attachment', 1))
    await flush()
    h.queue.clear()
    answer(h.calls[0] as Call)
    expect(await sent).toEqual({ state: 'failed' })
    expect(await queued).toEqual({ state: 'failed' })
    // a new request after the clear asks again, not sharing the old answer
    const fresh = h.queue.request(item('attachment', 0))
    await flush()
    expect(h.calls).toHaveLength(2)
    answer(h.calls[1] as Call)
    expect((await fresh).state).toBe('lease')
  })

  it('holds a lowered batch and calls in flight', async () => {
    MINT_QUEUE.batch = 7
    MINT_QUEUE.inFlight = 3
    const h = harness()
    for (let i = 0; i < 50; i++) void h.queue.request(item('attachment', i))
    await flush()
    expect(h.calls.map((c) => c.ids.length)).toEqual([7, 7, 7])
    while (h.calls.some((c) => !('done' in c))) {
      for (const call of h.calls.filter((c) => !('done' in c))) {
        answer(call)
        Object.assign(call, { done: true })
      }
      await flush()
    }
    expect(h.calls.map((c) => c.ids.length)).toEqual([7, 7, 7, 7, 7, 7, 7, 1])
    expect(h.most()).toBe(3)
  })
})
