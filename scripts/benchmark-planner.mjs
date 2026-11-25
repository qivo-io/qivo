// Deterministic, deployment-free delay projection and Auto-fit benchmark. Run with Node.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

// the everyday organization's people and each one's open tasks, as the
// load benchmark grows it (scripts/load/options.mjs EVERYDAY_ORG)
const EVERYDAY_PEOPLE = 50
const EVERYDAY_TASKS_EACH = 3

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
  const { autoFitEndWeek } = await server.ssrLoadModule('/src/lib/workload.ts')
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
  // `count` open tasks of up to `tenths` tenths of an hour over `owners`
  // people. Every tenth is in a project the reader cannot see, so it is
  // only a load row without a task id.
  const fixture = (count, owners, tenths = 720) => {
    let randomState = 20261001
    const random = (max) => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
      return Math.floor((randomState / 2 ** 32) * max)
    }
    const load = new Map(Array.from({ length: owners }, (_, i) => [`owner-${i}`, []]))
    const issues = []
    for (let index = 0; index < count; index++) {
      const start = TODAY_WEEK - 12 + random(52)
      const issue = {
        uuid: `task-${index}`,
        owner: `owner-${random(owners)}`,
        status: index % 5 === 0 ? 'review' : 'progress',
        isGroup: index % 17 === 0,
        paused: index % 19 === 0,
        start,
        end: start + random(12),
        remainingSet: start + random(6),
        remaining: random(tenths) / 10,
        dueWeek: start + 3 + random(16),
        duePast: start + 8 < TODAY_WEEK,
        capacity: 32,
      }
      const hidden = index % 10 === 9
      // paused tasks and groups carry no load
      if (!issue.paused && !issue.isGroup) {
        load.get(issue.owner).push({
          issueUuid: hidden ? null : issue.uuid,
          start: issue.start,
          end: issue.end,
          remainingSet: issue.remainingSet,
          remaining: issue.remaining,
        })
      }
      if (!hidden) issues.push(issue)
    }
    return { issues, load }
  }
  const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]
  const timed = (iterations, run) => {
    const measure = () => {
      const start = performance.now()
      for (let i = 0; i < iterations; i++) run()
      return (performance.now() - start) / iterations
    }
    for (let i = 0; i < 3; i++) measure()
    const times = Array.from({ length: 9 }, measure)
    return { 'median ms': median(times).toFixed(3), 'slowest ms': Math.max(...times).toFixed(3) }
  }
  const results = []
  let observed = 0
  // One figure at its design size a case: an organization's 10,000 open
  // tasks over the everyday people, its 1,000 people with the everyday open
  // tasks each, and one person with a sub-project's 300 open tasks and with
  // a project's 800.
  for (const [count, owners] of [
    [10000, EVERYDAY_PEOPLE],
    [1000 * EVERYDAY_TASKS_EACH, 1000],
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
    results.push({
      'open tasks': count,
      owners,
      ...timed(iterations, () => {
        observed += computeDelayMap(issues, load).size
      }),
    })
  }
  // A drop in a planning session for one person with a sub-project's 300
  // open tasks, a load the Roadmap reads whole: Auto-fit of a task from
  // each of the next 20 weeks in turn. Among tasks of up to 10 hours, about
  // 40 weeks of work, a 120-hour task's search walks several ends, and the
  // end it gives does not read Behind plan while a week earlier does. Among
  // 200 tasks planned over ten years and 100 one-week tasks that fill
  // every other week, a 2,000-hour task's search walks ends until it stops
  // at its limit, and the end it then gives, where the free hours cover
  // the task, does not read Behind plan.
  const { fitWalksSoFar } = await server.ssrLoadModule('/convex/lib/workload.ts')
  const fits = []
  const halfFull = [
    ...Array.from({ length: 200 }, (_, i) => ({
      issueUuid: `long-${i}`,
      start: TODAY_WEEK,
      end: TODAY_WEEK + 519,
      remaining: 41.6,
    })),
    ...Array.from({ length: 100 }, (_, i) => ({
      issueUuid: `week-${i}`,
      start: TODAY_WEEK + 2 * i + 1,
      end: TODAY_WEEK + 2 * i + 1,
      remaining: 16,
    })),
  ]
  for (const [name, tasks, spans, remaining, earliest] of [
    ['tasks of up to 10 hours', 300, fixture(300, 1, 100).load.get('owner-0'), 120, true],
    ['every other week full', 300, halfFull, 2000, false],
  ]) {
    const starts = Array.from({ length: 20 }, (_, i) => TODAY_WEEK + i)
    const task = (start) => ({ issueUuid: 'planned', start, remaining })
    const verdict = (start, end) =>
      delayOf(
        {
          uuid: 'planned',
          status: 'progress',
          owner: 'owner-0',
          start,
          end,
          dueWeek: null,
          duePast: false,
          remaining,
          capacity: 32,
        },
        spans,
      )?.status
    const walked = fitWalksSoFar()
    let found = 0
    for (const start of starts) {
      const end = autoFitEndWeek(spans, task(start), 32, TODAY_WEEK)
      if (end === null) continue
      found++
      assert.equal(verdict(start, end), 'ok')
      if (earliest) assert.equal(verdict(start, end - 1), 'behind')
    }
    assert.equal(found, starts.length)
    let next = 0
    fits.push({
      load: name,
      'open tasks': tasks,
      'ends walked a drop': (fitWalksSoFar() - walked) / starts.length,
      'ends found': `${found} of ${starts.length}`,
      ...timed(starts.length, () =>
        autoFitEndWeek(spans, task(starts[next++ % starts.length]), 32, TODAY_WEEK),
      ),
    })
  }
  assert.ok(observed > 0)
  console.log(`Node ${process.version}; 9 samples after 3 warmups.`)
  console.log(
    'Fixtures include fractional hours, measured windows, review owners and hidden load, ' +
      'a tenth of the open tasks in projects the reader cannot see.',
  )
  console.log('Delay projection of every open task:')
  console.table(results)
  console.log('Auto-fit of one drop:')
  console.table(fits)
} finally {
  await server?.close()
  await rm(cacheDir, { recursive: true, force: true })
}
