// Deterministic, deployment-free delay projection benchmark. Run with Node.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const cacheDir = await mkdtemp(join(tmpdir(), 'qivo-planner-benchmark-'))
let server
try {
  server = await createServer({
    root,
    cacheDir,
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null },
  })
  const { computeDelayMap, delayOf } = await server.ssrLoadModule('/src/lib/delay.ts')
  const { TODAY_WEEK } = await server.ssrLoadModule('/src/lib/dates.ts')
  const baseline = (issues, load) => {
    const result = new Map()
    for (const issue of issues) {
      const info = delayOf(issue, load.get(issue.owner) || [])
      if (info) result.set(issue.uuid, info)
    }
    return result
  }
  const fixture = (count) => {
    let randomState = 20261001
    const random = (max) => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
      return Math.floor((randomState / 2 ** 32) * max)
    }
    const owners = Math.max(5, Math.ceil(count / 100))
    const load = new Map(Array.from({ length: owners }, (_, i) => [`owner-${i}`, []]))
    const issues = Array.from({ length: count }, (_, index) => {
      const start = TODAY_WEEK - 12 + random(52)
      const issue = {
        uuid: `task-${index}`,
        owner: `owner-${random(owners)}`,
        status: index % 13 === 0 ? 'done' : index % 5 === 0 ? 'review' : 'progress',
        isGroup: index % 17 === 0,
        start,
        end: start + random(12),
        remainingSet: start + random(6),
        remaining: random(720) / 10,
        dueWeek: start + 3 + random(16),
        duePast: start + 8 < TODAY_WEEK,
        capacity: [16, 24, 32, 37.5][index % 4],
      }
      // Paused tasks (every nineteenth), done tasks and groups contribute no load.
      if (index % 19 && issue.status !== 'done' && !issue.isGroup) {
        load.get(issue.owner).push({
          issueUuid: issue.uuid,
          start: issue.start,
          end: issue.end,
          remainingSet: issue.remainingSet,
          remaining: issue.remaining,
        })
      }
      return issue
    })
    for (const spans of load.values()) {
      for (let i = 0; i < 8; i++) {
        spans.push({
          issueUuid: null,
          start: TODAY_WEEK - 4 + i * 3,
          end: TODAY_WEEK + i * 3,
          remaining: 20 + i / 3,
        })
      }
    }
    return { issues, load, owners }
  }
  const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]
  const results = []
  let observed = 0
  for (const count of [100, 1000, 10000]) {
    const { issues, load, owners } = fixture(count)
    assert.deepEqual(computeDelayMap(issues, load), baseline(issues, load))
    const iterations = Math.max(1, Math.ceil(10000 / count))
    const measure = (calculate) => {
      const start = performance.now()
      for (let i = 0; i < iterations; i++) observed += calculate(issues, load).size
      return (performance.now() - start) / iterations
    }
    for (let i = 0; i < 3; i++) {
      measure(baseline)
      measure(computeDelayMap)
    }
    const old = []
    const current = []
    for (let sample = 0; sample < 9; sample++) {
      // Alternate order to reduce warmup and machine-load bias.
      if (sample % 2) {
        current.push(measure(computeDelayMap))
        old.push(measure(baseline))
      } else {
        old.push(measure(baseline))
        current.push(measure(computeDelayMap))
      }
    }
    results.push({
      tasks: count,
      owners,
      'baseline median ms': median(old).toFixed(3),
      'optimized median ms': median(current).toFixed(3),
      speedup: `${(median(old) / median(current)).toFixed(2)}x`,
    })
  }
  assert.ok(observed > 0)
  console.log(`Delay projection only; Node ${process.version}; 9 samples after 3 warmups.`)
  console.log('Fixtures include fractional hours, measured windows, review owners and hidden load.')
  console.table(results)
} finally {
  await server?.close()
  await rm(cacheDir, { recursive: true, force: true })
}
