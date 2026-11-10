// The combined load benchmark's figures (scripts/benchmark-load.mjs): the
// local backend's function log entries as it reads them, the statistics
// per function and per client, and the output JSON's shape, kept here so a
// test can check them without a backend.

import { LEADER_CALLS, LEADER_READS } from './frames.mjs'

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

/** The distinct errors of log entries `list`, at most three, each its
    first 120 characters with its count, the most frequent first, so a
    reader can tell a refusal from a time limit or a cancelled call. */
function errorCounts(list) {
  const counts = new Map()
  for (const entry of list) {
    if (!entry.error) continue
    const text = entry.error.replace(/\[Request ID: [^\]]*\] /, '').slice(0, 120)
    counts.set(text, (counts.get(text) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([error, count]) => ({ error, count }))
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
      errors: errorCounts(list),
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

/** Idle phase `idle`'s answers and calls split into the leaders' share and
    the views', per session per minute over `seconds`: the `leaders`
    sessions' beats, claims, summaries and the answers and answer bytes of
    their own reads, and the other answers and answer bytes over all
    `sessions`. So a replayed session's idle compares with a real tab's part
    by part, whether or not it leads. Bytes are the answers' values; the
    frame bytes, pings included, are the phase's bytes_total. */
export function idleShares(idle, { sessions, leaders, seconds }) {
  const minutes = Math.max(seconds, 1e-9) / 60
  const per = (value, count) => (count > 0 ? Math.round((value / count / minutes) * 100) / 100 : 0)
  const answers = Object.entries(idle.answers ?? {})
  const sum = (rows, field) => rows.reduce((all, [, entry]) => all + entry[field], 0)
  const own = answers.filter(([name]) => LEADER_READS.includes(name))
  const views = answers.filter(([name]) => !LEADER_READS.includes(name))
  const calls = (name) => idle.client_calls?.[name]?.calls ?? 0
  return {
    leader: {
      sessions: leaders,
      ...Object.fromEntries(LEADER_CALLS.map((name) => [name, per(calls(name), leaders)])),
      answers: Object.fromEntries(
        own.map(([name, entry]) => [
          name,
          { answers: per(entry.updates, leaders), bytes: per(entry.bytes, leaders) },
        ]),
      ),
    },
    views: {
      sessions,
      answers: per(sum(views, 'updates'), sessions),
      bytes: per(sum(views, 'bytes'), sessions),
    },
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

/** The hypervisor's share of the CPU, in percent, from which a phase is
    marked noisy and is no timing. */
export const NOISY_STEAL_PCT = 10

/** Whether a phase whose steal is `steal` (cpuShare's) is noisy: true at
    NOISY_STEAL_PCT or more, false below it, and null, unknown, where the
    steal could not be read, so an unmeasured phase never counts as a clean
    timing. */
export const noisyOf = (steal) => (steal ? steal.steal_pct >= NOISY_STEAL_PCT : null)

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
        "The local backend's function log stream (/api/stream_function_logs): executions, cache answers, failures and their errors, JavaScript time (userExecutionTime) and total time (executionTime) per top-level call. The stream drops entries when its queue fills, so log_coverage compares the mutations and actions the clients and the changes' writer sent with the log and counts its failed reads: a phase whose coverage is lower_bounds has counts that are lower bounds, one whose coverage is unknown had nothing to compare, and its clients' own times stand beside them. Queries are not compared, since the backend answers a subscription from its cache with no log entry.",
      client_ms:
        "Each client's own clocks: a mutation's time from its frame to its response, a query's time from its Add to its first answer (client_first_answer_ms), and time to current, to the moment its newest set became current (a leader's with its Inbox feed answered), from the phase's start or the close and from the socket's open.",
      bytes:
        "Each client's received WebSocket frames: an answer's bytes are its value's JSON length, bytes_total every frame's, pings included, and a change's re-send what each client received until the next change.",
      idle: "The idle phase over its sessions and minutes: per_session_minute for what the sessions ask and the backend's own jobs apart, shares for the leaders' beats, claims and own reads apart from the views' answers, watched_per_minute for one login's tabs.",
      backend_at_once:
        'The most top-level calls whose log intervals (executionTimestamp to timestamp) overlap.',
      in_flight:
        "The clients' own counts of mutations awaiting their response and queries awaiting their first answer, sampled every 100 ms, summed over the processes' maxima.",
      steal:
        '/proc/stat over the phase, as the coordinator read it; a phase at 10% steal or more is marked noisy, and one whose steal could not be read has noisy null, unknown.',
      event_loop_lag:
        "Each process's monitorEventLoopDelay over the phase, past its 10 ms resolution.",
      pacing_trigger:
        "A model, not a hosted measurement: a phase whose clients asked more than hosted Professional's 256 queries at one moment (every subscription at startup, the re-subscriptions at the reconnect, the answers one change re-sent), a call whose JavaScript passed the 0.5 s line, or a client whose time to current after the reconnect passed ten times the lone client's. The local backend's overload closes (1013) are its own saturation, listed as test_bed_saturated, and fire nothing.",
    },
    recorded,
    match,
    phases,
    subscriptions,
    not_run: notRun,
  }
}

/** The watched clients' answers over the idle phase (`watched`, the
    workers' { client, udfPath, updates, bytes }) per minute, by client
    and function. */
export function watchedPerMinute(watched, seconds) {
  const minutes = Math.max(seconds, 1e-9) / 60
  const out = {}
  for (const { client, udfPath, updates, bytes } of watched ?? []) {
    out[client] ??= {}
    out[client][udfPath] = {
      answers: Math.round((updates / minutes) * 100) / 100,
      bytes: Math.round(bytes / minutes),
    }
  }
  return out
}

/**
 * How far the function log covers a phase whose statistics are `stats`
 * (functionStats'): each mutation and action the clients sent (`calls`,
 * mergeCalls') and the changes' writer sent and saw succeed
 * (`writerCalls`, a count by function), against the executions the log
 * holds of it, since every such call runs once at least. `state` is
 * `complete` when the log holds them all and no read of it failed
 * (`readFailures`), `lower_bounds` when it holds fewer of some (`missed`)
 * or a read failed, so the phase's counts are lower bounds, and `unknown`
 * when nothing was sent to compare, as in a phase whose clients lead no
 * alerts. Queries are not compared: the backend answers a subscription
 * from its cache with no log entry, so fewer entries than answers is no
 * proof of a dropped one.
 */
export function logCoverage(stats, calls, { writerCalls = {}, readFailures = 0 } = {}) {
  const sent = {}
  for (const [name, done] of Object.entries(calls)) sent[name] = (sent[name] ?? 0) + done.calls
  for (const [name, count] of Object.entries(writerCalls)) sent[name] = (sent[name] ?? 0) + count
  const missed = Object.entries(sent)
    .map(([name, count]) => ({
      fn: name,
      calls: count,
      logged: stats.functions[name]?.executions ?? 0,
    }))
    .filter((row) => row.logged < row.calls)
  const compared = Object.keys(sent).length
  return {
    state:
      missed.length > 0 || readFailures > 0
        ? 'lower_bounds'
        : compared > 0
          ? 'complete'
          : 'unknown',
    compared,
    missed,
    read_failures: readFailures,
  }
}

/** One phase's figures: the log's per function statistics and its
    coverage (logCoverage, with the writer's calls and the log's failed
    reads from `extra.writer_calls` and `extra.log_read_failures`), the
    backend's calls at once, the workers' bytes, calls, closes, calls in
    flight and event loop lag, `extra`, and whether `extra.steal` makes
    the phase noisy (noisyOf). */
export function phaseFigures(entries, seconds, reports, extra) {
  const stats = functionStats(entries, seconds)
  const calls = mergeCalls(reports.map((report) => report.calls))
  const logged = (name) => stats.functions[name]?.executions ?? 0
  const perClient = reports.flatMap((report) => report.per_client_bytes)
  const closes = {}
  for (const report of reports)
    for (const [code, count] of Object.entries(report.closes))
      closes[code] = (closes[code] ?? 0) + count
  return {
    clients: perClient.length,
    seconds: Math.round(seconds * 10) / 10,
    ...stats,
    over_line: overLine(stats),
    backend_at_once: mostAtOnce(entries.filter((entry) => !entry.nested)),
    client_calls: Object.fromEntries(
      Object.entries(calls).map(([name, done]) => [
        name,
        {
          calls: done.calls,
          failed: done.failed,
          client_ms: spread(done.ms),
          logged: logged(name),
        },
      ]),
    ),
    log_coverage: logCoverage(stats, calls, {
      writerCalls: extra.writer_calls,
      readFailures: extra.log_read_failures ?? 0,
    }),
    bytes_per_client: spread(perClient.map((client) => client.bytes)),
    bytes_total: perClient.reduce((all, client) => all + client.bytes, 0),
    answers: mergeCounts(reports.map((report) => report.answers)),
    closes,
    dropped_by_benchmark: reports.reduce((all, report) => all + report.dropped, 0),
    watched: reports.flatMap((report) => report.watched ?? []),
    in_flight_most: reports.reduce((all, report) => all + report.in_flight_most, 0),
    processes: reports.map((report) => ({
      pid: report.pid,
      clients: report.clients,
      event_loop_lag_ms: report.event_loop_lag_ms,
    })),
    _changes: reports.flatMap((report) => report.changes),
    ...extra,
    noisy: noisyOf(extra.steal),
  }
}

/** Adds to each change of the changes phase `figures` what the clients
    received after it, until the next change: the bytes re-sent to each of
    the `clients` (those that got none count as 0) and the queries each
    re-send updated with the answers they hold, and to the phase the bytes
    per client per change by kind of change and the most answers one change
    re-sent (`asked_at_once`, the change's reruns the pacing trigger's model
    reads, hostedModel). */
export function attachResends(figures, clients) {
  const byKind = {}
  let most = 0
  for (const change of figures.changes) {
    const slots = figures._changes.filter((slot) => slot.id === change.id)
    const perClient = new Map()
    for (const slot of slots)
      for (const [index, bytes] of Object.entries(slot.per_client)) perClient.set(index, bytes)
    const bytes = Array.from({ length: clients }, (_, index) => perClient.get(String(index)) ?? 0)
    change.resent_bytes_per_client = spread(bytes)
    change.clients_resent = perClient.size
    change.updated = mergeCounts(slots.map((slot) => slot.queries))
    change.answers = Object.values(change.updated).reduce((all, entry) => all + entry.updates, 0)
    most = Math.max(most, change.answers)
    byKind[change.kind] = [...(byKind[change.kind] ?? []), ...bytes]
  }
  figures.bytes_per_client_per_change = Object.fromEntries(
    Object.entries(byKind).map(([kind, bytes]) => [kind, spread(bytes)]),
  )
  figures.asked_at_once = most
}

/** The sums of `{ updates, bytes }` maps `maps` by key. */
export function mergeCounts(maps) {
  const out = {}
  for (const map of maps)
    for (const [name, entry] of Object.entries(map)) {
      const sum = out[name] ?? { updates: 0, bytes: 0 }
      sum.updates += entry.updates
      sum.bytes += entry.bytes
      out[name] = sum
    }
  return out
}

/** The sums of `{ calls, failed, ms }` maps `maps` (the trackers' calls)
    by function. */
export function mergeCalls(maps) {
  const out = {}
  for (const map of maps)
    for (const [name, done] of Object.entries(map)) {
      const entry = out[name] ?? { calls: 0, failed: 0, ms: [] }
      entry.calls += done.calls
      entry.failed += done.failed
      entry.ms.push(...done.ms)
      out[name] = entry
    }
  return out
}

/** The queries hosted Convex's Professional plan runs at once, which the
    pacing trigger's model holds the replay's load against. */
export const HOSTED_QUERY_SLOTS = 256

/**
 * The modelled hosted load of each phase of `phases`, a model and not a
 * hosted measurement: `asked_at_once`, the most queries the clients asked
 * of the backend at one moment as the phase recorded it (every
 * subscription at startup, the re-subscriptions at the reconnect, the most
 * answers one change re-sent, which leaves out a rerun whose answer did not
 * change), null for a phase with no such moment, and `running_on_average`,
 * the executed queries' total time over the phase's seconds, the queries a
 * backend runs at once on average, from the function log and so a lower
 * bound where its coverage is. `past_slots` lists the phases that asked
 * more than HOSTED_QUERY_SLOTS at once.
 */
export function hostedModel(phases) {
  const model = {}
  for (const [name, figures] of Object.entries(phases)) {
    const queryMs = Object.values(figures.functions ?? {})
      .filter((fn) => fn.kind === 'Query')
      .reduce((all, fn) => all + (fn.total_ms_sum ?? 0), 0)
    model[name] = {
      asked_at_once: figures.asked_at_once ?? null,
      running_on_average: figures.seconds
        ? Math.round((queryMs / (figures.seconds * 1000)) * 100) / 100
        : null,
    }
  }
  return {
    phases: model,
    past_slots: Object.entries(model)
      .filter(([, one]) => (one.asked_at_once ?? 0) > HOSTED_QUERY_SLOTS)
      .map(([name, one]) => ({ phase: name, asked_at_once: one.asked_at_once })),
  }
}

/**
 * The pacing trigger over `phases`, judged against the modelled hosted
 * query limit (hostedModel) rather than the local backend's overload, as
 * the later-work entry on the combined load of 9 November 2026 in
 * qivo-internal asks: a phase whose modelled load asked more than
 * HOSTED_QUERY_SLOTS queries at once, a call whose JavaScript passed the
 * 0.5 s line and a client whose time to current after the reconnect passed
 * ten times the lone client's, each with what showed it. The local
 * backend's overload closes (1013) are the test bed's saturation, listed
 * by phase under `test_bed_saturated`, and fire nothing, since they say
 * nothing of hosted Convex's limit. Where a phase's log coverage is not
 * `complete` (`log_incomplete`), a trigger that did not fire answers null,
 * unknown, since the calls the log missed may have passed the line.
 */
export function pacingTrigger(phases) {
  const saturated = Object.entries(phases).filter(
    ([, figures]) => (figures.closes?.['1013'] ?? 0) > 0,
  )
  // each call over the line says whether its phase was noisy, which the reader judges
  const over = Object.entries(phases).flatMap(([name, figures]) =>
    (figures.over_line ?? []).map((entry) => ({ phase: name, noisy: figures.noisy, ...entry })),
  )
  const slow = phases.reconnect?.slow_clients ?? null
  const model = hostedModel(phases)
  const past = model.past_slots.length > 0
  // a log that may have missed calls cannot show that none passed the line
  const incomplete = Object.entries(phases)
    .filter(([, figures]) => figures.log_coverage?.state !== 'complete')
    .map(([name]) => name)
  const unless = (fires) => (fires ? true : incomplete.length > 0 ? null : false)
  return {
    line_ms: JS_LINE_MS,
    hosted_query_slots: HOSTED_QUERY_SLOTS,
    hosted_model: model.phases,
    past_hosted_slots: model.past_slots,
    over_line: over,
    slow_reconnects: slow,
    test_bed_saturated: saturated.map(([name, figures]) => ({
      phase: name,
      overload_closes: figures.closes['1013'],
    })),
    log_incomplete: incomplete,
    fires: unless(past || over.length > 0 || (slow ?? 0) > 0),
    fires_outside_noisy_phases: unless(
      past || over.some((entry) => !entry.noisy) || (slow ?? 0) > 0,
    ),
  }
}

/** The tabs part's idle phase `idle` per minute: each tab's bytes, frames
    and answers, by function too, from its `per_tab`, and the backend's
    executions and JavaScript time from its `functions` (functionStats'). */
export function tabsIdlePerMinute(idle) {
  const minutes = Math.max(idle.seconds, 1e-9) / 60
  const round = (value) => Math.round((value / minutes) * 100) / 100
  const functions = Object.entries(idle.functions)
  return {
    per_tab_minute: idle.per_tab.map((tab) => ({
      index: tab.index,
      view: tab.view,
      bytes: round(tab.bytes),
      frames: round(tab.frames),
      answers: round(Object.values(tab.answers).reduce((all, entry) => all + entry.updates, 0)),
      answers_by_function: Object.fromEntries(
        Object.entries(tab.answers).map(([name, entry]) => [
          name,
          { updates: round(entry.updates), bytes: round(entry.bytes) },
        ]),
      ),
    })),
    backend_per_minute: {
      executions: round(functions.reduce((all, [, fn]) => all + fn.executions, 0)),
      js_ms: round(functions.reduce((all, [, fn]) => all + fn.js_ms_sum, 0)),
      functions: Object.fromEntries(
        functions.map(([name, fn]) => [
          name,
          { executions: round(fn.executions), js_ms: round(fn.js_ms_sum) },
        ]),
      ),
    },
  }
}

/** What the tabs part's `changes` (runChanges') re-sent to each of `tabs`
    ({ index, view, perChange }, perChange a Map from a change's id to the
    { bytes, queries } the tab received after it): each change's per-tab
    re-send, added to the change, and the spread of each tab's and each
    view's bytes by kind of change. */
export function tabResends(changes, tabs) {
  const byTab = {}
  const byView = {}
  for (const done of changes) {
    done.resent_per_tab = tabs.map((tab) => ({
      index: tab.index,
      view: tab.view,
      bytes: tab.perChange.get(done.id)?.bytes ?? 0,
      queries: tab.perChange.get(done.id)?.queries ?? {},
    }))
    byTab[done.kind] ??= {}
    byView[done.kind] ??= {}
    for (const tab of done.resent_per_tab) {
      byTab[done.kind][tab.index] = [...(byTab[done.kind][tab.index] ?? []), tab.bytes]
      byView[done.kind][tab.view] = [...(byView[done.kind][tab.view] ?? []), tab.bytes]
    }
  }
  const spreads = (groups) =>
    Object.fromEntries(
      Object.entries(groups).map(([kind, lists]) => [
        kind,
        Object.fromEntries(Object.entries(lists).map(([key, bytes]) => [key, spread(bytes)])),
      ]),
    )
  return { bytes_per_tab_per_change: spreads(byTab), bytes_per_view_per_change: spreads(byView) }
}
