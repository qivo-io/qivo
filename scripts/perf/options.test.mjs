import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSERS,
  benchmarkOptions,
  DEFAULT_SIZES,
  OptionsError,
  SIZE_CASE_SHAPE,
  workspaceParameters,
} from './options.mjs'

/* The browser benchmark's options (scripts/perf/options.mjs) and the
   workspace its default cases put in the stand-in (scripts/perf/server.mjs). */

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The stand-in's whole for page parameters `params`, loaded as its worker
    would be (as scripts/perf/server.test.mjs loads it). */
async function standInWhole(params) {
  vi.resetModules()
  const posted = []
  vi.stubGlobal('self', {
    name: `latency=0&mbps=100000&${params}`,
    postMessage: (message) => posted.push(message),
  })
  await import('./server.mjs')
  await self.onmessage({ data: { type: 'query', id: 'q', name: 'snapshot:forMe', args: {} } })
  return JSON.parse(posted.find((message) => message.type === 'result').text)
}

/* The design size's figures a case of the benchmark can raise, per
   organization (AGENTS.md). */
const DESIGN = {
  openInProject: 800,
  doneInProject: 200,
  openInSubproject: 300,
  doneInSubproject: 150,
  subprojectsInProject: 30,
  openInOrg: 10_000,
  doneInOrg: 5_000,
}

/** Each design-size figure of the stand-in's whole `whole`: the largest
    count any one project, sub-project or the organization holds. Tasks
    whose sub-project the whole does not list are the hidden program's. */
function figuresOf(whole) {
  const parentOf = new Map(whole.projects.map((p) => [p.id, p.parent_id ?? null]))
  const project = (subprojectId) => parentOf.get(subprojectId) ?? 'hidden'
  const count = (rows, key) => {
    const counts = new Map()
    for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1)
    return Math.max(0, ...counts.values())
  }
  const open = whole.issues.filter((row) => row.status !== 'done')
  const done = whole.issues.filter((row) => row.status === 'done')
  const subprojects = new Map()
  for (const row of whole.issues) {
    const holder = project(row.project_id)
    subprojects.set(holder, new Set([...(subprojects.get(holder) ?? []), row.project_id]))
  }
  return {
    openInProject: count(open, (row) => project(row.project_id)),
    doneInProject: count(done, (row) => project(row.project_id)),
    openInSubproject: count(open, (row) => row.project_id),
    doneInSubproject: count(done, (row) => row.project_id),
    subprojectsInProject: Math.max(...[...subprojects.values()].map((set) => set.size)),
    openInOrg: open.length,
    doneInOrg: done.length,
  }
}

describe('the browser benchmark options', () => {
  it('drives the browser --browser names, Chromium by default', () => {
    expect(benchmarkOptions([]).browser).toBe('chromium')
    expect(benchmarkOptions(['--browser', 'webkit']).browser).toBe('webkit')
    expect(benchmarkOptions(['--browser', 'firefox']).browser).toBe('firefox')
    expect(BROWSERS).toEqual(['chromium', 'firefox', 'webkit'])
  })

  it('refuses a browser it does not drive', () => {
    for (const name of ['safari', 'Chromium', 'edge', ''])
      expect(() => benchmarkOptions(['--browser', name]), name).toThrow(OptionsError)
    expect(() => benchmarkOptions(['--browser', 'safari'])).toThrow(
      '--browser takes chromium, firefox, webkit, not safari',
    )
  })

  it('slows the CPU only in Chromium, and refuses a slowdown asked of another browser', () => {
    expect(benchmarkOptions([]).cpu).toBe(4)
    expect(benchmarkOptions(['--cpu', '1']).cpu).toBe(1)
    expect(benchmarkOptions(['--browser', 'firefox']).cpu).toBe(1)
    expect(benchmarkOptions(['--browser', 'webkit', '--cpu', '1']).cpu).toBe(1)
    expect(() => benchmarkOptions(['--browser', 'webkit', '--cpu', '4'])).toThrow(OptionsError)
  })

  it('takes the sizes, the thread figures and the baseline it is given', () => {
    const options = benchmarkOptions(['--sizes', '300', '--thread', '100,150', '--baseline'])
    expect(options.sizes).toEqual([300])
    expect(options.threadFigures).toEqual([100, 150])
    expect(options.baselineRevision).toBe('')
    expect(benchmarkOptions(['--baseline', 'abc123', '--phone']).baselineRevision).toBe('abc123')
    expect(benchmarkOptions([]).baselineRevision).toBeNull()
    expect(benchmarkOptions(['--files', '?images=100']).filesQuery).toBe('&images=100')
  })
})

describe("the benchmark's default cases", () => {
  it('runs the default sizes when none are given', () => {
    expect(benchmarkOptions([]).sizes).toEqual(DEFAULT_SIZES)
  })

  it('raise at most one figure to its design size and none past it', async () => {
    const atDesignSize = []
    for (const tasks of DEFAULT_SIZES) {
      const figures = figuresOf(
        await standInWhole(`${workspaceParameters(tasks)}${SIZE_CASE_SHAPE}`),
      )
      for (const [figure, most] of Object.entries(DESIGN))
        expect(figures[figure], `${figure} at ${tasks} tasks`).toBeLessThanOrEqual(most)
      const reached = Object.keys(DESIGN).filter((figure) => figures[figure] === DESIGN[figure])
      expect(reached.length, `figures at their design size at ${tasks} tasks`).toBeLessThanOrEqual(
        1,
      )
      atDesignSize.push(...reached)
    }
    // the largest default case is the design size's open tasks of a project
    expect(atDesignSize).toEqual(['openInProject'])
  }, 30_000)
})
