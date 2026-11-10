import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSERS,
  benchmarkOptions,
  DEFAULT_SIZES,
  OptionsError,
  SIZE_CASE_SHAPE,
  STATUS_WRITES,
  SYNC_CASE,
  VARIED_CASE_SHAPE,
  workspaceParameters,
} from './options.mjs'

/* The browser benchmark's options (scripts/perf/options.mjs) and the
   workspace its default cases put in the stand-in (scripts/perf/server.mjs). */

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The stand-in for page parameters `params`, loaded as its worker would
    be (as scripts/perf/server.test.mjs loads it). `tasks()` answers its
    whole, which holds the visible tasks, and the hidden program's tasks,
    which the whole leaves out. `create(subproject)` stores the person's
    own To Do task there as the sample's create phase sends it
    (issues:create), and `scenario(name)` runs one of the deliveries the
    benchmark asks of it. */
async function standIn(params) {
  vi.resetModules()
  const posted = []
  vi.stubGlobal('self', {
    name: `latency=0&mbps=100000&${params}`,
    postMessage: (message) => posted.push(message),
  })
  const { hiddenTasks } = await import('./server.mjs')
  let asked = 0
  const ask = async (data) => {
    const id = `ask-${asked++}`
    await self.onmessage({ data: { ...data, id } })
    // a read's result names it in `to`, a write's or a scenario's answer in `id`
    const answer = posted.find((message) => message.to === id || message.id === id)
    const refusal = answer?.failure ?? answer?.error
    if (refusal) throw new Error(refusal.message ?? refusal)
    return answer
  }
  return {
    tasks: async () => {
      const answer = await ask({ type: 'query', name: 'snapshot:forMe', args: {} })
      return { whole: JSON.parse(answer.text), hidden: hiddenTasks }
    },
    create: (subproject) =>
      ask({
        type: 'mutation',
        name: 'issues:create',
        args: {
          id: crypto.randomUUID(),
          project_id: subproject,
          title: 'Check the spare sensors on the north bench before the cold week',
          status: 'todo',
          priority: 'medium',
        },
      }),
    scenario: (name) => ask({ type: 'scenario', name, args: [] }),
  }
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

/** Each design-size figure of the stand-in's tasks: the largest count any
    one project, sub-project or the organization holds, over the visible
    tasks of `whole` and the hidden program's `hidden`. The whole lists only
    the visible projects, so a sub-project it does not list is one of the
    hidden program's. */
function figuresOf({ whole, hidden }) {
  const parentOf = new Map(whole.projects.map((p) => [p.id, p.parent_id ?? null]))
  const project = (subprojectId) => parentOf.get(subprojectId) ?? 'hidden'
  const count = (rows, key) => {
    const counts = new Map()
    for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1)
    return Math.max(0, ...counts.values())
  }
  const tasks = [...whole.issues, ...hidden]
  const open = tasks.filter((row) => row.status !== 'done')
  const done = tasks.filter((row) => row.status === 'done')
  const subprojects = new Map()
  for (const row of tasks) {
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

/** The design-size figures `figures` holds at their design size, after
    checking that none is past it and that at most one is at it. `where`
    names the state for a failure. */
function atDesignSize(figures, where) {
  for (const [figure, most] of Object.entries(DESIGN))
    expect(figures[figure], `${figure} ${where}`).toBeLessThanOrEqual(most)
  const reached = Object.keys(DESIGN).filter((figure) => figures[figure] === DESIGN[figure])
  expect(reached.length, `figures at their design size ${where}`).toBeLessThanOrEqual(1)
  return reached
}

describe("the benchmark's default cases", () => {
  it('runs the default sizes when none are given', () => {
    expect(benchmarkOptions([]).sizes).toEqual(DEFAULT_SIZES)
  })

  it('raise at most one figure to its design size and none past it, after each phase that adds a task', async () => {
    const reached = new Set()
    for (const tasks of DEFAULT_SIZES) {
      const server = await standIn(`${workspaceParameters(tasks)}${SIZE_CASE_SHAPE}`)
      const fixture = await server.tasks()
      // the hidden program holds tasks too, which the whole leaves out
      expect(fixture.hidden.length, `hidden tasks at ${tasks} tasks`).toBeGreaterThan(0)
      const states = [[`at ${tasks} tasks`, fixture]]
      // The create phase adds one To Do task to the sub-project of the task
      // the drag moved, which can be any visible one, and deletes it again
      // untimed; remoteCreate adds another person's task and deletes it.
      const subprojects = fixture.whole.projects.filter((p) => p.parent_id).map((p) => p.id)
      for (const subproject of subprojects) {
        await server.create(subproject)
        states.push([`after the create in ${subproject} at ${tasks} tasks`, await server.tasks()])
        await server.scenario('deliverDelete')
      }
      await server.scenario('deliverCreate')
      states.push([`after remoteCreate at ${tasks} tasks`, await server.tasks()])
      await server.scenario('deliverDelete')
      expect(figuresOf(await server.tasks()), `after the deletes at ${tasks} tasks`).toEqual(
        figuresOf(fixture),
      )
      for (const [where, state] of states)
        for (const figure of atDesignSize(figuresOf(state), where)) reached.add(figure)
    }
    // the largest default case's creates hold the design size's open tasks
    // of a project
    expect([...reached]).toEqual(['openInProject'])
  }, 30_000)

  /* The varied sample's drag moves a To Do card to In Progress and the
     Team sync sample types a Remaining, so neither adds a task or moves
     one into or out of Done. */
  it("--fixture varied's pages stay within the design size", async () => {
    for (const tasks of DEFAULT_SIZES) {
      const varied = await standIn(`${workspaceParameters(tasks)}${VARIED_CASE_SHAPE}`)
      atDesignSize(figuresOf(await varied.tasks()), `on the varied page at ${tasks} tasks`)
    }
    const sync = await standIn(`${workspaceParameters(SYNC_CASE.tasks)}${SYNC_CASE.shape}`)
    const figures = figuresOf(await sync.tasks())
    for (const [figure, most] of Object.entries(DESIGN))
      expect(figures[figure], `${figure} on the Team sync page`).toBeLessThanOrEqual(most)
    // the meeting reads a project's open and Done tasks, so the page holds
    // both at their design size, at their sum, and no other figure
    expect(Object.keys(DESIGN).filter((figure) => figures[figure] === DESIGN[figure])).toEqual([
      'openInProject',
      'doneInProject',
    ])
  }, 30_000)

  it('change a status only from one open status to another', () => {
    expect(Object.keys(STATUS_WRITES).length).toBeGreaterThan(0)
    for (const [from, to] of Object.entries(STATUS_WRITES)) {
      expect(from, `a change of a ${from} task`).not.toBe('done')
      expect(to, `the change of a ${from} task`).not.toBe('done')
      expect(to, `the change of a ${from} task`).not.toBe(from)
    }
  })
})
