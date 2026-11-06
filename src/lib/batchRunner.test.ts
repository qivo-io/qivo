import { describe, expect, it } from 'vitest'
import {
  KEEP_OPEN,
  LANES_AT_ONCE,
  type LanePool,
  type LaneRun,
  lanePool,
  roundsOf,
  runLanes,
} from './batchRunner'

/* The shared runner with fake lanes: each send waits until the test
   answers or refuses it, so the order and the number of sends in flight
   are the test's to see. A lane is an organization's name, and its
   answers count its batches, `more` while fewer than its plan. */

type Sent = {
  lane: string
  n: number
  answer: () => void
  refuse: (error: unknown) => void
}

const PAUSE = new Error('paused')
const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** A run over lanes with `plan[lane]` batches each, whose sends the test
    settles through `sent`. */
function harness(
  plan: Record<string, number>,
  extra: Partial<LaneRun<string, number>> = {},
  pool?: LanePool,
) {
  const sent: Sent[] = []
  const events: string[] = []
  let flying = 0
  let most = 0
  let live = true
  const run = runLanes<string, number>({
    lanes: Object.keys(plan),
    pool,
    live: () => live,
    send: (lane, previous) =>
      new Promise<number>((resolve, reject) => {
        flying++
        most = Math.max(most, flying)
        const n = (previous ?? 0) + 1
        events.push(`send ${lane} ${n}`)
        sent.push({
          lane,
          n,
          answer: () => {
            flying--
            resolve(n)
          },
          refuse: (error) => {
            flying--
            reject(error)
          },
        })
      }),
    more: (lane, answer) => answer < plan[lane],
    pauseOf: (error) => (error === PAUSE ? 'Qivo is offline.' : null),
    reasonOf: (error) => `refused: ${(error as Error).message}`,
    onAnswer: (lane, answer) => events.push(`answer ${lane} ${answer}`),
    onStop: (stop) =>
      events.push(`stop ${stop.lane} ${stop.reason}${stop.paused ? ' paused' : ''}`),
    onLaneEnd: (lane, last) => events.push(`end ${lane}${last ? ' last' : ''}`),
    ...extra,
  })
  /** The send of `lane`'s batch `n` that waits now. */
  const at = (lane: string, n: number) => {
    const found = sent.find((s) => s.lane === lane && s.n === n)
    if (!found) throw new Error(`no send ${lane} ${n} in ${JSON.stringify(events)}`)
    return found
  }
  return {
    run,
    events,
    at,
    flying: () => flying,
    most: () => most,
    end: () => {
      live = false
    },
  }
}

describe('roundsOf', () => {
  it('counts the rounds of the longest lanes first, two at once', () => {
    expect(roundsOf([1])).toBe(1)
    expect(roundsOf([2])).toBe(2)
    expect(roundsOf([1, 1])).toBe(1)
    expect(roundsOf([1, 1, 1])).toBe(2)
    expect(roundsOf([1, 3, 1])).toBe(3)
    expect(roundsOf([2, 2, 1])).toBe(3)
    expect(roundsOf([40])).toBe(40)
    expect(roundsOf([1, 1, 1], 3)).toBe(1)
  })

  it('pins the shared numbers and the keep-open sentence', () => {
    expect(LANES_AT_ONCE).toBe(2)
    expect(KEEP_OPEN).toBe(
      'Keep Qivo open until it finishes. Closing or reloading Qivo stops it, and the steps already done stay done.',
    )
  })
})

describe('runLanes', () => {
  it('sends each lane one batch at a time, two lanes at once, the third once one ends', async () => {
    const h = harness({ a: 2, b: 1, c: 1 })
    await tick()
    expect(h.events).toEqual(['send a 1', 'send b 1'])
    h.at('a', 1).answer()
    await tick()
    // a's next batch, never two of one lane together
    expect(h.events.slice(2)).toEqual(['answer a 1', 'send a 2'])
    expect(h.flying()).toBe(2)
    h.at('b', 1).answer()
    await tick()
    expect(h.events.slice(4)).toEqual(['answer b 1', 'end b', 'send c 1'])
    h.at('a', 2).answer()
    h.at('c', 1).answer()
    expect(await h.run).toEqual({ finished: ['b', 'a', 'c'], stops: [] })
    expect(h.most()).toBe(2)
    expect(h.events.filter((e) => e.startsWith('end'))).toEqual(['end b', 'end a', 'end c last'])
  })

  it('stops a refused lane with its later batches unsent while the others finish', async () => {
    const h = harness({ a: 3, b: 2 })
    await tick()
    h.at('a', 1).refuse(new Error('read-only'))
    await tick()
    h.at('b', 1).answer()
    await tick()
    h.at('b', 2).answer()
    expect(await h.run).toEqual({
      finished: ['b'],
      stops: [{ lane: 'a', reason: 'refused: read-only', paused: false }],
    })
    expect(h.events.filter((e) => e.startsWith('send a'))).toEqual(['send a 1'])
  })

  it('stops every lane at the pause, before its next batch, and the queued lanes before they send', async () => {
    const h = harness({ a: 3, b: 3, c: 1 })
    await tick()
    h.at('a', 1).refuse(PAUSE)
    await tick()
    // b's batch in flight still lands, and b stops before its next one
    h.at('b', 1).answer()
    expect(await h.run).toEqual({
      finished: [],
      stops: [
        { lane: 'a', reason: 'Qivo is offline.', paused: true },
        { lane: 'c', reason: 'Qivo is offline.', paused: true },
        { lane: 'b', reason: 'Qivo is offline.', paused: true },
      ],
    })
    expect(h.events.filter((e) => e.startsWith('send'))).toEqual(['send a 1', 'send b 1'])
    expect(h.events.filter((e) => e.endsWith('last'))).toHaveLength(1)
  })

  it('ends quietly once live turns false, with no callback after', async () => {
    const h = harness({ a: 2, b: 2, c: 1 })
    await tick()
    const before = h.events.length
    h.end()
    h.at('a', 1).answer()
    h.at('b', 1).refuse(new Error('read-only'))
    expect(await h.run).toBeNull()
    expect(h.events.length).toBe(before)
  })

  it('counts a throw from onAnswer as its lane refusal', async () => {
    const h = harness(
      { a: 2, b: 1 },
      {
        onAnswer: (lane) => {
          if (lane === 'a') throw new Error('a paint threw')
        },
      },
    )
    await tick()
    h.at('a', 1).answer()
    h.at('b', 1).answer()
    expect(await h.run).toEqual({
      finished: ['b'],
      stops: [{ lane: 'a', reason: 'refused: a paint threw', paused: false }],
    })
  })

  it('rejects at once on a fault in onStop, and sends nothing after it', async () => {
    const h = harness(
      { a: 2, b: 3 },
      {
        onStop: () => {
          throw new Error('a toast threw')
        },
      },
    )
    await tick()
    h.at('a', 1).refuse(new Error('read-only'))
    await expect(h.run).rejects.toThrow('a toast threw')
    h.at('b', 1).answer()
    await tick()
    expect(h.events.filter((e) => e.startsWith('send'))).toEqual(['send a 1', 'send b 1'])
  })

  it('rejects on a fault in onLaneEnd', async () => {
    const h = harness(
      { a: 1, b: 1 },
      {
        onLaneEnd: () => {
          throw new Error('an umbrella threw')
        },
      },
    )
    await tick()
    h.at('a', 1).answer()
    await expect(h.run).rejects.toThrow('an umbrella threw')
  })

  it('shares one pool of two lanes between runs, so a second run waits for a free lane', async () => {
    const pool = lanePool(2)
    const first = harness({ a: 2, b: 1 }, {}, pool)
    const second = harness({ c: 1 }, {}, pool)
    await tick()
    expect(second.events).toEqual([])
    first.at('b', 1).answer()
    await tick()
    // b's lane is free, so c sends while a still runs
    expect(second.events).toEqual(['send c 1'])
    expect(first.flying() + second.flying()).toBe(2)
    second.at('c', 1).answer()
    first.at('a', 1).answer()
    await tick()
    first.at('a', 2).answer()
    expect(await first.run).toEqual({ finished: ['b', 'a'], stops: [] })
    expect(await second.run).toEqual({ finished: ['c'], stops: [] })
  })

  it('gives a run without a pool lanes of its own', async () => {
    const pool = lanePool(2)
    const first = harness({ a: 1, b: 1 }, {}, pool)
    const alone = harness({ c: 1 })
    await tick()
    expect(alone.events).toEqual(['send c 1'])
    for (const s of ['a', 'b']) first.at(s, 1).answer()
    alone.at('c', 1).answer()
    await Promise.all([first.run, alone.run])
  })
})
