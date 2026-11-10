// The combined load benchmark's options (scripts/benchmark-load.mjs), read
// from its command line and environment here so a test can check them
// without a backend or a browser. One table (OPTIONS) holds every option
// with the parts that read it, and both the parser and the help text
// (usage) come from it. The benchmark's header says what each part
// measures.

/** The parts, what each does, and the parts `all` runs in turn. */
export const PARTS = {
  setup: 'grows Northstar to the everyday organization; writes <dir>/people.json',
  record: "records each view's query set from one real tab; writes <dir>/sets/<view>.json",
  replay: 'replays the sets with Node clients through its phases; writes one rung',
  tabs: "opens one person's real tabs at once through the same phases; writes one rung",
  all: 'setup, record and replay in turn',
}
const ALL = ['setup', 'record', 'replay']

/** The views the record part opens, one real tab each, by the names the
    recorded sets and the output use. */
export const VIEWS = ['board', 'overview', 'roadmap', 'sync', 'inbox', 'mine']

/** Each part's phases and the ones it runs when --phases names none.
    `match` checks the replay against the recorded tabs before any load,
    when named, and `startup` opens the clients or tabs and always runs;
    those two come first, and the others run in the order --phases names
    them, each timed on its own. `busy` is the changes again beside
    --busy-loops busy loops. */
export const PHASES = {
  replay: {
    allowed: ['match', 'startup', 'changes', 'reconnect', 'idle', 'busy'],
    default: ['match', 'startup', 'changes', 'reconnect', 'idle'],
  },
  tabs: {
    allowed: ['startup', 'changes', 'reconnect', 'idle'],
    default: ['startup', 'changes', 'reconnect', 'idle'],
  },
}

/** The browsers the record part drives, by their Playwright names. */
export const BROWSERS = ['chromium', 'firefox', 'webkit']

/** A loopback HTTP origin, the only kind the benchmark talks to, as the
    local seeds accept it (scripts/marketing-demo.mjs LOOPBACK_ORIGIN). */
export const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):[0-9]{1,5}$/

/** A CPU list as taskset takes it, such as 0-7 or 0,2,4-6. */
const CPU_LIST = /^[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*$/

/** The everyday organization the setup part grows Northstar to: its people,
    agents included, its teams and the open tasks each person it adds is
    made the assignee of. */
export const EVERYDAY_ORG = { people: 50, teams: 10, tasksEach: 3 }

/**
 * Every option: the parts that read it, its key in the options, what it
 * takes (`origin`, `count` of at least `least`, `list` of `of`, `one` of
 * `of`, `text`, `path`, `cpus`, or `flag` for none), its default and its
 * help line.
 */
export const OPTIONS = {
  url: {
    parts: ['setup', 'record', 'replay', 'tabs'],
    key: 'url',
    takes: 'origin',
    default: 'http://127.0.0.1:3236',
    help: "the local backend's loopback origin",
  },
  'site-url': {
    parts: ['record', 'replay', 'tabs'],
    key: 'siteUrl',
    takes: 'origin',
    default: 'http://localhost:5241',
    help: "the app's loopback origin, the Vite dev server or a production build",
  },
  deployment: {
    parts: ['record', 'replay', 'tabs'],
    key: 'deployment',
    takes: 'text',
    default: 'local-sc-3236',
    help: "the local deployment the seed filed Nora's fixture login under",
  },
  dir: {
    parts: ['setup', 'record', 'replay', 'tabs'],
    key: 'dir',
    takes: 'path',
    default: 'dev-temp/load',
    help: 'the working folder of people.json, sets/ and out/',
  },
  output: {
    parts: ['replay', 'tabs'],
    key: 'output',
    takes: 'path',
    default: null,
    help: "the rung's JSON file, else <dir>/out/rung-<clients>.json or tabs-<tabs>.json",
  },
  people: {
    parts: ['setup'],
    key: 'people',
    takes: 'count',
    default: EVERYDAY_ORG.people,
    help: 'the profiles of each organization, agents included',
  },
  teams: {
    parts: ['setup'],
    key: 'teams',
    takes: 'count',
    default: EVERYDAY_ORG.teams,
    help: 'the teams of each organization',
  },
  'tasks-each': {
    parts: ['setup'],
    key: 'tasksEach',
    takes: 'count',
    least: 0,
    default: EVERYDAY_ORG.tasksEach,
    help: 'the open tasks each added person is made the assignee of; 0 leaves them none',
  },
  orgs: {
    parts: ['setup', 'replay'],
    key: 'orgs',
    takes: 'count',
    default: 1,
    help: 'the organizations at everyday size, Northstar first, that setup makes and replay deals its clients to',
  },
  browser: {
    parts: ['record', 'replay', 'tabs'],
    key: 'browser',
    takes: 'one',
    of: BROWSERS,
    default: 'chromium',
    help: "the recorded tabs', the hidden tab's and the tabs part's browser",
  },
  views: {
    parts: ['record', 'tabs'],
    key: 'views',
    takes: 'list',
    of: VIEWS,
    default: VIEWS,
    help: 'the views recorded, and those the tabs part opens in turn',
  },
  'board-top': {
    parts: ['record'],
    key: 'boardTop',
    takes: 'flag',
    default: false,
    help: "records the Board on Luma Sensor's whole project, not its Firmware sub-project",
  },
  clients: {
    parts: ['replay'],
    key: 'clients',
    takes: 'count',
    default: 10,
    help: 'the replayed sessions, one a person',
  },
  processes: {
    parts: ['replay'],
    key: 'processes',
    takes: 'count',
    default: 2,
    help: 'the worker processes the sessions are dealt to',
  },
  tabs: {
    parts: ['tabs'],
    key: 'tabs',
    takes: 'count',
    default: 1,
    help: "Nora's real tabs, all open at once in one browser profile",
  },
  phases: {
    parts: ['replay', 'tabs'],
    key: 'phases',
    takes: 'list',
    of: [...new Set([...PHASES.replay.allowed, ...PHASES.tabs.allowed])],
    default: null,
    help: `the phases, replay ${PHASES.replay.allowed.join(',')} (default ${PHASES.replay.default.join(',')}), tabs ${PHASES.tabs.allowed.join(',')}`,
  },
  changes: {
    parts: ['replay', 'tabs'],
    key: 'changes',
    takes: 'count',
    default: 20,
    help: 'the changes of the changes and busy phases, one a second',
  },
  'idle-s': {
    parts: ['replay', 'tabs'],
    key: 'idleSeconds',
    takes: 'count',
    default: 120,
    help: "the idle phase's seconds",
  },
  'busy-loops': {
    parts: ['replay'],
    key: 'busyLoops',
    takes: 'count',
    default: 8,
    help: "the busy phase's spinning processes",
  },
  'busy-cpus': {
    parts: ['replay'],
    key: 'busyCpus',
    takes: 'cpus',
    default: null,
    help: "the CPUs the busy loops are pinned to with taskset, the backend's",
  },
  'no-hidden-tab': {
    parts: ['replay'],
    key: 'noHiddenTab',
    takes: 'flag',
    default: false,
    help: 'leaves out the real Board tab hidden through the reconnect',
  },
  'quiet-ms': {
    parts: ['record', 'replay', 'tabs'],
    key: 'quietMs',
    takes: 'count',
    least: 100,
    default: 3000,
    help: 'how long a tab or a client stays quiet before it counts as settled',
  },
  'timeout-ms': {
    parts: ['record', 'replay', 'tabs'],
    key: 'timeoutMs',
    takes: 'count',
    least: 1000,
    default: 90_000,
    help: 'how long a tab or a client may take to settle',
  },
}

/** The words each kind of value shows in the help text. */
const SHOWN = {
  origin: '<origin>',
  count: '<n>',
  text: '<text>',
  path: '<path>',
  cpus: '<cpus>',
  flag: '',
}

/** The help text: the command, the parts and every option with the parts
    that read it and its default. */
export function usage() {
  const lines = [
    'QIVO_LOCAL_ADMIN_KEY=… node scripts/benchmark-load.mjs <part> [options]',
    '',
    'Only against a disposable local backend; see the header of scripts/benchmark-load.mjs.',
    '',
    'Parts:',
    ...Object.entries(PARTS).map(([name, text]) => `  ${name.padEnd(8)}${text}`),
    '',
    'Options, with the parts that read them:',
  ]
  for (const [name, spec] of Object.entries(OPTIONS)) {
    const value =
      spec.takes === 'one' || spec.takes === 'list'
        ? `<${spec.of.join(spec.takes === 'one' ? '|' : ',')}>`
        : SHOWN[spec.takes]
    const fallback =
      spec.default === null || spec.takes === 'flag'
        ? ''
        : ` (${Array.isArray(spec.default) ? spec.default.join(',') : spec.default})`
    lines.push(`  --${name}${value ? ` ${value}` : ''}`)
    lines.push(`      ${spec.help}${fallback} [${spec.parts.join(', ')}]`)
  }
  return lines.join('\n')
}

/** An option or environment the benchmark cannot run with. Its message
    says why. */
export class OptionsError extends Error {}

/** The end of the refusal of option text `text`, which is undefined when
    the option ends the command line. */
const given = (text) => (text === undefined ? ', and none followed it' : `, not ${text}`)

/** The value of option `name` (OPTIONS[name]) its `text` holds. Throws an
    OptionsError for a value it does not take. */
function parsed(name, spec, text) {
  const refuse = (what) => {
    throw new OptionsError(`--${name} takes ${what}${given(text)}`)
  }
  if (spec.takes === 'count') {
    const least = spec.least ?? 1
    const value = Number(text)
    if (text === undefined || text.trim() === '' || !Number.isInteger(value) || value < least)
      refuse(`a whole number of at least ${least}`)
    return value
  }
  if (spec.takes === 'list') {
    const items = text === undefined ? [] : text.split(',').map((item) => item.trim())
    if (items.length === 0 || items.some((item) => !spec.of.includes(item)))
      refuse(`a comma list of ${spec.of.join(', ')}`)
    return [...new Set(items)]
  }
  if (spec.takes === 'one') {
    if (!spec.of.includes(text)) refuse(spec.of.join(', '))
    return text
  }
  if (spec.takes === 'origin') {
    const origin = text?.replace(/\/$/, '')
    if (origin === undefined || !LOOPBACK_ORIGIN.test(origin))
      refuse(
        'a loopback origin such as http://127.0.0.1:3236; the benchmark runs only against a disposable local backend',
      )
    return origin
  }
  if (spec.takes === 'cpus') {
    if (!CPU_LIST.test(text ?? '')) refuse('a CPU list such as 0-7')
    return text
  }
  if (text === undefined || text.startsWith('--')) refuse('a value')
  return text
}

/**
 * The benchmark's options from `argv` (process.argv's arguments after the
 * script) and `env` (process.env). The first argument is the part, or
 * `--help`, which answers { help: true }. Throws an OptionsError, before
 * anything runs, for an unknown part, an option the part does not read, a
 * value an option does not take, a backend or app address that is not
 * loopback, more processes or organizations than clients, a phase the part
 * does not run, a deploy key in the environment and a missing admin key.
 * The admin key is read from QIVO_LOCAL_ADMIN_KEY, as the local seeds read
 * it, and never printed.
 */
export function loadOptions(argv, env) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true }
  const part = argv[0]
  if (!Object.hasOwn(PARTS, part))
    throw new OptionsError(
      `The first argument is the part, ${Object.keys(PARTS).join(', ')}${given(part)}`,
    )
  const parts = part === 'all' ? ALL : [part]
  const options = { parts }
  for (const spec of Object.values(OPTIONS)) options[spec.key] = spec.default
  for (let i = 1; i < argv.length; i++) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : null
    const spec = name === null ? undefined : OPTIONS[name]
    if (!spec) throw new OptionsError(`${argv[i]} is no option of the benchmark`)
    if (!spec.parts.some((one) => parts.includes(one)))
      throw new OptionsError(`--${name} is an option of ${spec.parts.join(', ')}, not of ${part}`)
    options[spec.key] = spec.takes === 'flag' ? true : parsed(name, spec, argv[++i])
  }
  if (parts.includes('replay')) {
    if (options.processes > options.clients)
      throw new OptionsError(
        `--processes ${options.processes} is more than --clients ${options.clients}`,
      )
    if (options.orgs > options.clients)
      throw new OptionsError(`--orgs ${options.orgs} is more than --clients ${options.clients}`)
  }
  const phased = parts.find((one) => PHASES[one])
  if (phased) {
    const { allowed, default: fallback } = PHASES[phased]
    options.phases ??= fallback
    const other = options.phases.filter((phase) => !allowed.includes(phase))
    if (other.length > 0)
      throw new OptionsError(
        `--phases of ${phased} takes ${allowed.join(', ')}, not ${other.join(', ')}`,
      )
  }
  if (env.CONVEX_DEPLOY_KEY)
    throw new OptionsError(
      'CONVEX_DEPLOY_KEY is set. The benchmark runs only against a disposable local backend; unset it.',
    )
  if (!env.QIVO_LOCAL_ADMIN_KEY)
    throw new OptionsError("QIVO_LOCAL_ADMIN_KEY must hold the local backend's admin key.")
  options.adminKey = env.QIVO_LOCAL_ADMIN_KEY
  return options
}
