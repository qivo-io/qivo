// Deterministic, deployment-free delay projection and palette search benchmarks. Run with Node.
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

  const { createPaletteSearch } = await server.ssrLoadModule('/src/lib/paletteSearch.ts')
  // Independent reference: normalize/score every row, stable-sort all matches,
  // then retain nine tasks. Project lookups are indexed in both implementations.
  const previousScore = (label, query) => {
    const normalized = label.toLowerCase()
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.every((word) => normalized.includes(word))) return 0
    const phrase = query.trim().toLowerCase().replace(/\s+/g, ' ')
    const index = normalized.indexOf(phrase)
    return index < 0 ? 0.25 : 1 - (index / Math.max(1, normalized.length)) * 0.5
  }
  const previousSearch = ({ projects, tasks, projectById, canSee }, query) => {
    if (!query.trim()) return { projects: [], issues: [] }
    const visibleProject = (project) => {
      const meta = project.type === 'meta' ? project : projectById.get(project.parent)
      return !!meta && canSee(meta.id)
    }
    return {
      projects: projects
        .filter(visibleProject)
        .map((project) => ({
          project,
          label: project.name,
          sub: project.type === 'meta' ? undefined : projectById.get(project.parent)?.name,
          score: previousScore(project.name, query),
        }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score),
      issues: tasks
        .filter((task) => {
          const project = projectById.get(task.project)
          return project && visibleProject(project)
        })
        .map((issue) => ({ issue, score: previousScore(`${issue.key} ${issue.title}`, query) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 9),
    }
  }
  const searchFixture = (count) => {
    const projects = []
    const hidden = new Set()
    const programs = Math.max(5, Math.ceil(count / 100))
    for (let index = 0; index < programs; index++) {
      const meta = `program-${index}`
      projects.push(
        { id: meta, name: `Signed firmware program ${index + 1}`, type: 'meta' },
        {
          id: `work-${index}`,
          name: `Firmware validation ${index + 1}`,
          type: 'project',
          parent: meta,
        },
      )
      if (index % 5 === 4) hidden.add(meta)
    }
    const titles = [
      'Review signed firmware bundle',
      'Ship firmware with signed manifest',
      'Validate FÄLT telemetry export',
      'Update privacy retention window',
      'Signed firmware release checklist',
      'Reconcile firmware signing certificates',
      'Confirm signed firmware device rollout',
    ]
    const tasks = Array.from({ length: count }, (_, index) => ({
      id: `task-${index}`,
      key: `QN-${index + 1}`,
      title: `${titles[index % titles.length]} ${index % 13}`,
      project: `work-${index % programs}`,
    }))
    return {
      projects,
      tasks,
      projectById: new Map(projects.map((project) => [project.id, project])),
      canSee: (id) => !hidden.has(id),
    }
  }
  const rankedIds = ({ projects, issues }) => ({
    projects: projects.map(({ project, score }) => ({ id: project.id, score })),
    issues: issues.map(({ issue, score }) => ({ id: issue.id, score })),
  })
  const queries = [
    { kind: 'phrase', text: 'signed firmware' },
    { kind: 'reordered', text: 'firmware signed' },
    { kind: 'key', text: 'qn-42' },
    { kind: 'no match', text: 'missingneedle-xyz' },
  ]
  const indexResults = []
  const searchResults = []
  for (const count of [100, 1000, 10000]) {
    const fixture = searchFixture(count)
    const { projects, tasks, canSee } = fixture
    const iterations = Math.max(1, Math.ceil(10000 / count))
    const buildIndex = () => createPaletteSearch(projects, tasks, canSee)
    const retained = buildIndex()
    for (const query of [...queries.map(({ text }) => text), '  ', 'fÄLt']) {
      assert.deepEqual(
        rankedIds(retained(query)),
        rankedIds(previousSearch(fixture, query)),
        `${count} tasks, query ${JSON.stringify(query)}`,
      )
    }
    let lastIndex
    const measureBuild = () => {
      const start = performance.now()
      for (let iteration = 0; iteration < iterations; iteration++) lastIndex = buildIndex()
      return (performance.now() - start) / iterations
    }
    for (let warmup = 0; warmup < 3; warmup++) measureBuild()
    const builds = Array.from({ length: 9 }, measureBuild)
    // Consume the final constructed index outside its timed construction interval.
    assert.deepEqual(
      rankedIds(lastIndex('signed firmware')),
      rankedIds(retained('signed firmware')),
    )
    indexResults.push({
      tasks: count,
      projects: projects.length,
      'index construction median ms': median(builds).toFixed(3),
    })
    for (const { kind, text } of queries) {
      const measureQuery = (search) => {
        const start = performance.now()
        for (let iteration = 0; iteration < iterations; iteration++) {
          const result = search(text)
          observed += result.projects.length + result.issues.length
        }
        return (performance.now() - start) / iterations
      }
      const baselineSearch = (query) => previousSearch(fixture, query)
      const old = []
      const current = []
      for (let sample = -3; sample < 9; sample++) {
        let previousMs
        let indexedMs
        if (sample % 2) {
          indexedMs = measureQuery(retained)
          previousMs = measureQuery(baselineSearch)
        } else {
          previousMs = measureQuery(baselineSearch)
          indexedMs = measureQuery(retained)
        }
        if (sample >= 0) {
          old.push(previousMs)
          current.push(indexedMs)
        }
      }
      searchResults.push({
        tasks: count,
        query: kind,
        'baseline median ms': median(old).toFixed(3),
        'retained index median ms': median(current).toFixed(3),
        speedup: `${(median(old) / median(current)).toFixed(2)}x`,
      })
    }
  }
  assert.ok(observed > 0)
  console.log('Palette search CPU only; 9 samples after 3 warmups, alternating query order.')
  console.log(
    'Exact ranked ids/scores checked; valid project trees include hidden work and Unicode.',
  )
  console.log(
    'Index construction is paid on a workspace change and excluded from retained queries.',
  )
  console.table(indexResults)
  console.table(searchResults)
} finally {
  await server?.close()
  await rm(cacheDir, { recursive: true, force: true })
}
