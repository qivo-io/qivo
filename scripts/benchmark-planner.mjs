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
  // every issue judged alone, each against a walk of its own
  const alone = (issues, load) => {
    const result = new Map()
    for (const issue of issues) {
      const info = delayOf(issue, load.get(issue.owner) || [])
      if (info) result.set(issue.uuid, info)
    }
    return result
  }
  const fixture = (count, owners) => {
    let randomState = 20261001
    const random = (max) => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
      return Math.floor((randomState / 2 ** 32) * max)
    }
    const load = new Map(Array.from({ length: owners }, (_, i) => [`owner-${i}`, []]))
    const issues = Array.from({ length: count }, (_, index) => {
      const start = TODAY_WEEK - 12 + random(52)
      const issue = {
        uuid: `task-${index}`,
        owner: `owner-${random(owners)}`,
        status: index % 13 === 0 ? 'done' : index % 5 === 0 ? 'review' : 'progress',
        isGroup: index % 17 === 0,
        paused: index % 19 === 0,
        start,
        end: start + random(12),
        remainingSet: start + random(6),
        remaining: random(720) / 10,
        dueWeek: start + 3 + random(16),
        duePast: start + 8 < TODAY_WEEK,
        capacity: 32,
      }
      // paused and done tasks and groups carry no load
      if (!issue.paused && issue.status !== 'done' && !issue.isGroup) {
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
    return { issues, load }
  }
  const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]
  const results = []
  let observed = 0
  // the design size's 10,000 open tasks of an organization over its 1,000
  // people, then one person with a sub-project's 300 open tasks and with a
  // project's 800, one figure at a time
  for (const [count, owners] of [
    [10000, 1000],
    [300, 1],
    [800, 1],
  ]) {
    const { issues, load } = fixture(count, owners)
    const shared = computeDelayMap(issues, load)
    // the shared walk gives each issue the verdict a walk of its own gives
    const sample = issues.filter((_, i) => i % Math.ceil(count / 200) === 0)
    const sampled = new Map(
      sample.flatMap((it) => (shared.has(it.uuid) ? [[it.uuid, shared.get(it.uuid)]] : [])),
    )
    assert.deepEqual(sampled, alone(sample, load))
    const iterations = Math.max(1, Math.ceil(2000 / count))
    const measure = () => {
      const start = performance.now()
      for (let i = 0; i < iterations; i++) observed += computeDelayMap(issues, load).size
      return (performance.now() - start) / iterations
    }
    for (let i = 0; i < 3; i++) measure()
    const times = Array.from({ length: 9 }, measure)
    results.push({
      tasks: count,
      owners,
      'median ms': median(times).toFixed(3),
      'slowest ms': Math.max(...times).toFixed(3),
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
