// The combined load benchmark's options (scripts/benchmark-load.mjs), read
// from its command line and environment here so a test can check them
// without a backend or a browser. The benchmark's header says what each
// part measures.

/** The parts the benchmark runs, in the order `all` runs them. */
export const PARTS = ['setup', 'record', 'replay']

/** The views the record part opens, one real tab each, by the names the
    recorded sets and the output use. */
export const VIEWS = ['board', 'overview', 'roadmap', 'sync', 'inbox', 'mine']

/** The replay part's phases, in the order it runs them. `match` checks the
    replay against the recorded tabs before any load, and each later phase
    is timed on its own. */
export const PHASES = ['match', 'startup', 'changes', 'reconnect', 'idle']

/** The browsers the record part drives, by their Playwright names. */
export const BROWSERS = ['chromium', 'firefox', 'webkit']

/** A loopback HTTP origin, the only kind the benchmark talks to, as the
    local seeds accept it (scripts/marketing-demo.mjs LOOPBACK_ORIGIN). */
export const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):[0-9]{1,5}$/

/** The everyday organization the setup part grows Northstar to: its people,
    agents included, and teams, and the teams each person it adds joins. */
export const EVERYDAY_ORG = { people: 50, teams: 10, teamsEach: 3 }

/** An option or environment the benchmark cannot run with. Its message
    says why. */
export class OptionsError extends Error {}

/** The end of the refusal of option text `text`, which is undefined when
    the option ends the command line. */
const given = (text) => (text === undefined ? ', and none followed it' : `, not ${text}`)

/** The whole number of at least `least` that option `name`'s `text`
    holds. Throws an OptionsError for anything else. */
function whole(name, text, least = 1) {
  const value = Number(text)
  if (text === undefined || text.trim() === '' || !Number.isInteger(value) || value < least)
    throw new OptionsError(`--${name} takes a whole number of at least ${least}${given(text)}`)
  return value
}

/** The items of option `name`'s comma list `text`, each one of `allowed`.
    Throws an OptionsError for an empty list or an unknown item. */
function listOf(name, text, allowed) {
  const items = text === undefined ? [] : text.split(',').map((item) => item.trim())
  const unknown = items.filter((item) => !allowed.includes(item))
  if (items.length === 0 || items.includes('') || unknown.length > 0)
    throw new OptionsError(`--${name} takes a comma list of ${allowed.join(', ')}${given(text)}`)
  return [...new Set(items)]
}

/** The loopback origin option `name` holds, without a trailing slash.
    Throws an OptionsError for any other address, so no part reaches a
    hosted deployment. */
function loopback(name, text) {
  const origin = text?.replace(/\/$/, '')
  if (origin === undefined || !LOOPBACK_ORIGIN.test(origin))
    throw new OptionsError(
      `--${name} takes a loopback origin such as http://127.0.0.1:3236${given(text)}; the benchmark runs only against a disposable local backend`,
    )
  return origin
}

/** The benchmark's options from `argv` (process.argv's arguments after
    the script) and `env` (process.env). The first argument is the part,
    `setup`, `record`, `replay` or `all`. Throws an OptionsError for an
    unknown part, view, phase or browser, for numbers that are not whole,
    for a backend or app address that is not loopback, for a deploy key
    in the environment and for a missing admin key, before anything runs.
    The admin key is read from QIVO_LOCAL_ADMIN_KEY, as the local seeds
    read it, and never printed. */
export function loadOptions(argv, env) {
  const part = argv[0]
  if (part !== 'all' && !PARTS.includes(part))
    throw new OptionsError(
      `The first argument is the part, ${[...PARTS, 'all'].join(', ')}${given(part)}`,
    )
  const option = (name, fallback) => {
    const index = argv.indexOf(`--${name}`)
    return index < 0 ? fallback : argv[index + 1]
  }
  if (env.CONVEX_DEPLOY_KEY)
    throw new OptionsError(
      'CONVEX_DEPLOY_KEY is set. The benchmark runs only against a disposable local backend; unset it.',
    )
  const adminKey = env.QIVO_LOCAL_ADMIN_KEY
  if (!adminKey)
    throw new OptionsError("QIVO_LOCAL_ADMIN_KEY must hold the local backend's admin key.")
  const browser = option('browser', 'chromium')
  if (!BROWSERS.includes(browser))
    throw new OptionsError(`--browser takes ${BROWSERS.join(', ')}${given(browser)}`)
  const clients = whole('clients', option('clients', '10'))
  const processes = whole('processes', option('processes', '2'))
  if (processes > clients)
    throw new OptionsError(`--processes ${processes} is more than --clients ${clients}`)
  return {
    parts: part === 'all' ? PARTS : [part],
    url: loopback('url', option('url', 'http://127.0.0.1:3236')),
    siteUrl: loopback('site-url', option('site-url', 'http://localhost:5241')),
    deployment: option('deployment', 'local-sc-3236'),
    dir: option('dir', 'dev-temp/load'),
    output: option('output', null),
    browser,
    views: listOf('views', option('views', VIEWS.join(',')), VIEWS),
    phases: listOf('phases', option('phases', PHASES.join(',')), PHASES),
    people: whole('people', option('people', String(EVERYDAY_ORG.people))),
    teams: whole('teams', option('teams', String(EVERYDAY_ORG.teams))),
    clients,
    processes,
    changes: whole('changes', option('changes', '20')),
    idleSeconds: whole('idle-s', option('idle-s', '120')),
    // the quiet a view or a client holds before it counts as idle
    quietMs: whole('quiet-ms', option('quiet-ms', '3000'), 100),
    timeoutMs: whole('timeout-ms', option('timeout-ms', '90000'), 1000),
    hiddenTab: !argv.includes('--no-hidden-tab'),
    adminKey,
  }
}
