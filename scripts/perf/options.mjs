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
    is an everyday project and the second holds the design size's open
    tasks of one project, with fewer Done than its Done figure. */
export const DEFAULT_SIZES = [100, 960]

/** The stand-in's page parameters of every --sizes case beside its tasks:
    the everyday sub-projects of a project and one hidden sub-project, so
    the project the person cannot see holds no more than one of the
    visible ones' sub-projects. */
export const SIZE_CASE_SHAPE = '&subprojects=3&hidden=1'

/** The page parameters that put `tasks` visible tasks in a stand-in
    workspace, spread over programsFor's top-level projects. */
export const workspaceParameters = (tasks) => `tasks=${tasks}&programs=${programsFor(tasks)}`

/** An option the benchmark cannot run with. Its message says why. */
export class OptionsError extends Error {}

/** The benchmark's options from `argv` (process.argv's arguments after
    the script). Throws an OptionsError for a browser it does not drive,
    and for a CPU slowdown asked of a browser that cannot apply one. */
export function benchmarkOptions(argv) {
  const option = (name, fallback) => {
    const index = argv.indexOf(`--${name}`)
    return index < 0 ? fallback : argv[index + 1]
  }
  const browser = option('browser', 'chromium')
  if (!BROWSERS.includes(browser))
    throw new OptionsError(`--browser takes ${BROWSERS.join(', ')}, not ${browser}`)
  // only Chromium's CDP session slows the CPU, so the others run at 1
  const cpu = Number(option('cpu', browser === 'chromium' ? '4' : '1'))
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
    sizes: option('sizes', DEFAULT_SIZES.join(',')).split(',').map(Number),
    samples: Number(option('samples', '5')),
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
    threadFigures: option('thread', null)?.split(',').map(Number) ?? null,
    phone: argv.includes('--phone'),
    // the stand-in's file parameters every page takes
    filesQuery: files ? `&${files.replace(/^[?&]/, '')}` : '',
    baselineRevision,
    serve: argv.includes('--serve'),
    // --trace prints each phase as it starts, to find a step that stalls
    trace: argv.includes('--trace'),
  }
}
