// The combined load benchmark's figures (scripts/benchmark-load.mjs): the
// local backend's function log entries as it reads them, the statistics
// per function and per client, and the output JSON's shape, kept here so a
// test can check them without a backend.

/** The output's format name, which a reader checks. */
export const REPORT_FORMAT = 'qivo-load-rung/1'

/** One entry of the local backend's function log stream
    (/api/stream_function_logs) as the figures read it, or null for an
    entry that is not a function's completion. Its times are in
    milliseconds: `start` and `end` since the epoch, `js_ms` the
    JavaScript time (userExecutionTime) and `total_ms` the whole execution
    (executionTime), both of which the stream gives in seconds. `fn` is
    the function as the client names it, without the module's `.js`. */
export function logEntry(raw) {
  if (raw?.kind !== 'Completion') return null
  const seconds = (value) => (typeof value === 'number' ? value * 1000 : null)
  const usage = raw.usageStats ?? {}
  return {
    fn: String(raw.identifier ?? '').replace(/\.js:/, ':'),
    component: raw.componentPath ?? null,
    kind: raw.udfType ?? null,
    nested: Boolean(raw.parentExecutionId),
    cached: Boolean(raw.cachedResult),
    start: seconds(raw.executionTimestamp),
    end: seconds(raw.timestamp),
    js_ms: seconds(raw.userExecutionTime),
    total_ms: seconds(raw.executionTime),
    read_documents: usage.databaseReadDocuments ?? null,
    read_bytes: usage.databaseReadBytes ?? null,
    error: raw.error ? String(raw.error).slice(0, 160) : null,
  }
}

/** The value at fraction `p` (0 to 1) of sorted numbers `sorted`, by the
    nearest rank, or null for none. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null
  const rank = Math.max(1, Math.ceil(p * sorted.length))
  return sorted[Math.min(sorted.length, rank) - 1]
}

/** Milliseconds `value` rounded to a tenth, or null. */
const tenth = (value) =>
  value === null || value === undefined ? null : Math.round(value * 10) / 10

/** The p50, p99 and maximum of numbers `values`, each to a tenth. */
export function spread(values) {
  const sorted = values.filter((value) => typeof value === 'number').sort((a, b) => a - b)
  return {
    count: sorted.length,
    p50: tenth(percentile(sorted, 0.5)),
    p99: tenth(percentile(sorted, 0.99)),
    max: tenth(sorted.at(-1) ?? null),
  }
}

/** Per function, the log entries `entries` (logEntry's) that ran in the
    `seconds` long phase: executions, executions a second, how many the
    cache answered, failures, and the JavaScript and total time spread of
    those that ran, with the phase's total time. Top-level calls only; a
    nested call's time is inside its caller's. */
export function functionStats(entries, seconds) {
  const byFn = new Map()
  for (const entry of entries) {
    if (entry.nested) continue
    const name = entry.component ? `${entry.component}/${entry.fn}` : entry.fn
    const list = byFn.get(name) ?? []
    list.push(entry)
    byFn.set(name, list)
  }
  const functions = {}
  let total = 0
  for (const [name, list] of [...byFn.entries()].sort()) {
    const ran = list.filter((entry) => !entry.cached)
    const sum = ran.reduce((all, entry) => all + (entry.total_ms ?? 0), 0)
    const js = ran.reduce((all, entry) => all + (entry.js_ms ?? 0), 0)
    total += sum
    functions[name] = {
      kind: list[0].kind,
      executions: list.length,
      per_second: Math.round((list.length / Math.max(seconds, 1e-9)) * 100) / 100,
      cached: list.length - ran.length,
      failed: list.filter((entry) => entry.error).length,
      js_ms: spread(ran.map((entry) => entry.js_ms)),
      total_ms: spread(ran.map((entry) => entry.total_ms)),
      js_ms_sum: tenth(js),
      total_ms_sum: tenth(sum),
    }
  }
  return { functions, backend_total_ms: tenth(total) }
}

/** Per function, the spread of the clients' own first-answer times
    `pairs` ([udfPath, milliseconds], FrameTracker firstAnswers'), the
    whole set's spread under `all`. */
export function firstAnswerStats(pairs) {
  const byFn = new Map()
  for (const [name, ms] of pairs) byFn.set(name, [...(byFn.get(name) ?? []), ms])
  return {
    all: spread(pairs.map(([, ms]) => ms)),
    functions: Object.fromEntries(
      [...byFn.entries()].sort().map(([name, ms]) => [name, spread(ms)]),
    ),
  }
}

/** Idle phase `idle` (its functionStats', bytes, answers and client calls)
    per session per minute over `sessions` sessions and `seconds`: the
    bytes and answers the sessions received, and for the functions of
    `own`, those the sessions subscribe or call, the executions and their
    JavaScript and total time. The backend's other work, its own jobs, is
    given per minute for the whole backend, since no session asks for it. */
export function perSessionMinute(idle, sessions, seconds, own) {
  const minutes = Math.max(seconds, 1e-9) / 60
  const round = (value) => Math.round(value * 100) / 100
  const per = (value) => round(value / sessions / minutes)
  const session = {}
  const background = {}
  for (const [name, figures] of Object.entries(idle.functions)) {
    if (own.has(name))
      session[name] = {
        executions: per(figures.executions),
        js_ms: per(figures.js_ms_sum),
        total_ms: per(figures.total_ms_sum),
      }
    else
      background[name] = {
        executions: round(figures.executions / minutes),
        js_ms: round(figures.js_ms_sum / minutes),
      }
  }
  const sum = (rows, field) => Object.values(rows).reduce((all, row) => all + row[field], 0)
  return {
    bytes: per(idle.bytes_total),
    answers: per(Object.values(idle.answers).reduce((all, entry) => all + entry.updates, 0)),
    executions: round(sum(session, 'executions')),
    js_ms: round(sum(session, 'js_ms')),
    total_ms: round(sum(session, 'total_ms')),
    functions: session,
    calls: Object.fromEntries(
      Object.entries(idle.client_calls).map(([name, done]) => [name, per(done.calls)]),
    ),
    backend_jobs_per_minute: background,
  }
}

/** The most of `intervals` ({ start, end } in milliseconds) that overlap
    at one moment, as the calls the backend ran at once. */
export function mostAtOnce(intervals) {
  const edges = []
  for (const { start, end } of intervals) {
    if (typeof start !== 'number' || typeof end !== 'number') continue
    edges.push([start, 1], [Math.max(start, end), -1])
  }
  // an end before a start at the same moment, so touching calls do not count twice
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let now = 0
  let most = 0
  for (const [, step] of edges) {
    now += step
    most = Math.max(most, now)
  }
  return most
}

/** The JavaScript time `line` (milliseconds) a call may take at the
    everyday values, the owner's 0.5 s line (design specification §9.1). */
export const JS_LINE_MS = 500

/** The functions of `stats` (functionStats') whose slowest JavaScript time
    passed `line`, each with that time. */
export function overLine(stats, line = JS_LINE_MS) {
  return Object.entries(stats.functions)
    .filter(([, figures]) => (figures.js_ms.max ?? 0) >= line)
    .map(([name, figures]) => ({ fn: name, js_ms_max: figures.js_ms.max }))
}

/** CPU counters of /proc/stat's first line, `text`, or null when it holds
    none: the total ticks, the idle ticks (idle and iowait) and the steal. */
export function cpuCounters(text) {
  const line = String(text ?? '').split('\n')[0]
  if (!line.startsWith('cpu ')) return null
  const fields = line.trim().split(/\s+/).slice(1).map(Number)
  return {
    total: fields.slice(0, 8).reduce((all, value) => all + value, 0),
    idle: fields[3] + fields[4],
    steal: fields[7] ?? 0,
  }
}

/** The steal and busy shares between counters `a` and `b`, in percent to
    a tenth, or null when either is missing. */
export function cpuShare(a, b) {
  if (!a || !b) return null
  const ticks = Math.max(1, b.total - a.total)
  const steal = b.steal - a.steal
  return {
    steal_pct: tenth((steal / ticks) * 100),
    busy_pct: tenth(((ticks - (b.idle - a.idle) - steal) / ticks) * 100),
    ticks,
  }
}

/** One rung's output: what ran, where and when (`rung`), the recorded
    sets' summaries (`recorded`), the replay's match with the tabs
    (`match`), each phase's figures (`phases`), item 9's subscriptions of
    one login per organization (`subscriptions`) and the phases that did
    not run with their reason (`not_run`). Each figure says where it came
    from in `sources`. */
export function rungReport({ rung, recorded, match, phases, subscriptions, notRun }) {
  return {
    format: REPORT_FORMAT,
    rung,
    sources: {
      functions:
        "The local backend's function log stream (/api/stream_function_logs): executions, cache answers, failures, JavaScript time (userExecutionTime) and total time (executionTime) per top-level call. The stream drops entries when its queue fills, so a saturating rung's counts are lower bounds and its per-call times come from the clients too.",
      client_ms:
        "Each client's own clocks: a mutation's time from its frame to its response, a query's time from its Add to its first answer, and time to current.",
      bytes:
        "Each client's received WebSocket frames: an answer's bytes are its value's JSON length.",
      backend_at_once:
        'The most top-level calls whose log intervals (executionTimestamp to timestamp) overlap.',
      in_flight:
        "The clients' own counts of mutations awaiting their response and queries awaiting their first answer, sampled every 100 ms, summed over the processes' maxima.",
      steal: '/proc/stat over the phase, as the coordinator read it.',
    },
    recorded,
    match,
    phases,
    subscriptions,
    not_run: notRun,
  }
}
