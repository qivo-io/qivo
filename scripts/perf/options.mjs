// The browser benchmark's options (scripts/benchmark-browser.mjs), read
// from its command line here so a test can check them without starting a
// browser. The benchmark's header says what each option measures.
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { programsFor } from './page.mjs'

/** The browsers the benchmark drives, by their Playwright names. */
export const BROWSERS = ['chromium', 'firefox', 'webkit']

/** The default --sizes, the visible tasks of each case. The stand-in makes
    every sixth task Done (scripts/perf/server.mjs STATUSES), so the first
    is an everyday project and the second holds one open task fewer than
    the design size's open tasks of one project, with fewer Done than its
    Done figure. The sample's create of one open task, and another person's
    create after it, each take that project to the design size and no
    further, since each is deleted before the next. */
export const DEFAULT_SIZES = [100, 958]

/** The status the sample's status changes write for a row in each status
    (benchmark-browser.mjs statusWrites). Each moves an open task to
    another open status, so no change moves a project's open or Done
    tasks, and the changes skip a Done row. */
export const STATUS_WRITES = {
  backlog: 'progress',
  todo: 'progress',
  progress: 'todo',
  review: 'progress',
}

/** The stand-in's page parameters of every --sizes case beside its tasks:
    the everyday sub-projects of a project and one hidden sub-project, so
    the project the person cannot see holds no more than one of the
    visible ones' sub-projects. */
export const SIZE_CASE_SHAPE = '&subprojects=3&hidden=1'

/** The stand-in's page parameters of --fixture varied's Board page beside
    each --sizes case's tasks: the varied workspace (scripts/perf/server.mjs
    shape=varied) with the stand-in's own sub-projects and hidden program. */
export const VARIED_CASE_SHAPE = '&shape=varied'

/** --fixture varied's Team sync page: its tasks and its page parameters,
    one project of 3 sub-projects, a fifth of its tasks Done, saved as Team
    sync's scope, and one hidden sub-project as full as a visible one. The
    project holds the design size's open and Done tasks of a project at
    their sum, since the meeting reads both. */
export const SYNC_CASE = {
  tasks: 1000,
  shape: '&subprojects=3&done=0.2&hidden=1&syncscope=program',
}

/** The page parameters that put `tasks` visible tasks in a stand-in
    workspace, spread over programsFor's top-level projects. */
export const workspaceParameters = (tasks) => `tasks=${tasks}&programs=${programsFor(tasks)}`

/** An option the benchmark cannot run with. Its message says why. */
export class OptionsError extends Error {}

/** The end of the refusal of option text `text`, which is undefined when
    the option ends the command line. */
const given = (text) => (text === undefined ? ', and none followed it' : `, not ${text}`)

/** The whole numbers of at least 1 that option `name`'s `text` lists,
    separated by commas, or the one it holds when `one` is set. Throws an
    OptionsError for anything else, such as an empty item or no value. */
function counts(name, text, one = false) {
  const values = text === undefined ? [] : text.split(',').map(Number)
  const whole = values.every((value) => Number.isInteger(value) && value >= 1)
  if (values.length === 0 || !whole || (one && values.length > 1))
    throw new OptionsError(
      `--${name} takes ${one ? 'a whole number' : 'whole numbers'} of at least 1${given(text)}`,
    )
  return values
}

/** The benchmark's options from `argv` (process.argv's arguments after
    the script). Throws an OptionsError for a browser it does not drive,
    for a CPU slowdown that is not a number of at least 1 or that a
    browser cannot apply, and for samples, sizes or thread figures that
    are not whole numbers of at least 1, before anything is built. */
export function benchmarkOptions(argv) {
  const option = (name, fallback) => {
    const index = argv.indexOf(`--${name}`)
    return index < 0 ? fallback : argv[index + 1]
  }
  const browser = option('browser', 'chromium')
  if (!BROWSERS.includes(browser))
    throw new OptionsError(`--browser takes ${BROWSERS.join(', ')}, not ${browser}`)
  // only Chromium's CDP session slows the CPU, so the others run at 1
  const cpuText = option('cpu', browser === 'chromium' ? '4' : '1')
  const cpu = Number(cpuText)
  if (cpuText === undefined || cpuText.trim() === '' || !Number.isFinite(cpu) || cpu < 1)
    throw new OptionsError(`--cpu takes a number of at least 1${given(cpuText)}`)
  if (browser !== 'chromium' && cpu !== 1)
    throw new OptionsError(`--cpu ${cpu} needs Chromium; ${browser} runs at --cpu 1`)
  const files = option('files', '')
  // --baseline, with the revision when one follows it
  const baselineAt = argv.indexOf('--baseline')
  const baselineRevision =
    baselineAt < 0
      ? null
      : argv[baselineAt + 1] && !argv[baselineAt + 1].startsWith('--')
        ? argv[baselineAt + 1]
        : ''
  return {
    browser,
    root: resolve(option('root', join(dirname(fileURLToPath(import.meta.url)), '../..'))),
    sizes: counts('sizes', option('sizes', DEFAULT_SIZES.join(','))),
    samples: counts('samples', option('samples', '5'), true)[0],
    cpu,
    latency: Number(option('latency', '100')),
    bandwidth: Number(option('mbps', '8')),
    output: option('output', '/tmp/qivo-browser-benchmark.json'),
    // long enough for a large --sizes case on the slow network, whose
    // results take seconds each at 8 Mbps
    timeout: Number(option('timeout', '60000')),
    // unread messages the bulk-read scenario adds just before it runs, so
    // the earlier scenarios load the same workspace as before it existed
    messages: Number(option('messages', '500')),
    host: option('host', '127.0.0.1'),
    varied: option('fixture', 'default') === 'varied',
    // --thread: the figures the task window's thread phase measures, alone
    threadFigures: argv.includes('--thread') ? counts('thread', option('thread')) : null,
    phone: argv.includes('--phone'),
    // the stand-in's file parameters every page takes
    filesQuery: files ? `&${files.replace(/^[?&]/, '')}` : '',
    baselineRevision,
    serve: argv.includes('--serve'),
    // --trace prints each phase as it starts, to find a step that stalls
    trace: argv.includes('--trace'),
  }
}
