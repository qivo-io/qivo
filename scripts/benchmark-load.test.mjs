import { describe, expect, it } from 'vitest'
import {
  checkSet,
  compareSets,
  FrameTracker,
  personQueries,
  recordedSet,
  SET_FORMAT,
  subscriptionsByOrganization,
  swapIds,
} from './load/frames.mjs'
import { EVERYDAY_ORG, loadOptions, OptionsError, PARTS, PHASES, VIEWS } from './load/options.mjs'
import {
  cpuCounters,
  cpuShare,
  functionStats,
  logEntry,
  mostAtOnce,
  overLine,
  percentile,
  perSessionMinute,
  REPORT_FORMAT,
  rungReport,
  spread,
} from './load/report.mjs'

/* The combined load benchmark's pure parts (scripts/benchmark-load.mjs):
   its options, the Convex frames it reads, the recorded set's format, the
   swap of one person's ids into a set, the per-function statistics and the
   output's shape. */

const KEY = { QIVO_LOCAL_ADMIN_KEY: 'local-admin-key' }

describe('the load benchmark options', () => {
  it('runs every part for all, with the everyday organization and 10 clients by default', () => {
    const options = loadOptions(['all'], KEY)
    expect(options.parts).toEqual(PARTS)
    expect(options).toMatchObject({
      url: 'http://127.0.0.1:3236',
      siteUrl: 'http://localhost:5241',
      browser: 'chromium',
      views: VIEWS,
      phases: PHASES,
      people: EVERYDAY_ORG.people,
      teams: EVERYDAY_ORG.teams,
      clients: 10,
      processes: 2,
      hiddenTab: true,
      adminKey: 'local-admin-key',
    })
  })

  it('takes one part with its views, phases, sizes and a loopback backend', () => {
    const options = loadOptions(
      [
        'replay',
        '--url',
        'http://localhost:3210/',
        '--views',
        'board,inbox,board',
        '--phases',
        'idle',
        '--clients',
        '100',
        '--processes',
        '4',
        '--no-hidden-tab',
      ],
      KEY,
    )
    expect(options).toMatchObject({
      parts: ['replay'],
      url: 'http://localhost:3210',
      views: ['board', 'inbox'],
      phases: ['idle'],
      clients: 100,
      processes: 4,
      hiddenTab: false,
    })
  })

  it.each([
    [['measure'], 'The first argument is the part'],
    [['record', '--url', 'https://happy-otter-123.convex.cloud'], 'loopback origin'],
    [['record', '--url', 'http://10.0.0.5:3236'], 'loopback origin'],
    [['record', '--site-url', 'https://qivo.io'], 'loopback origin'],
    [['record', '--browser', 'edge'], '--browser takes chromium, firefox, webkit'],
    [['record', '--views', 'board,calendar'], '--views takes a comma list'],
    [['replay', '--phases', ''], '--phases takes a comma list'],
    [['replay', '--clients', '0'], '--clients takes a whole number of at least 1, not 0'],
    [['replay', '--clients', '2.5'], '--clients takes a whole number'],
    [['replay', '--clients'], 'and none followed it'],
    [['replay', '--clients', '2', '--processes', '3'], '--processes 3 is more than --clients 2'],
  ])('refuses %j', (argv, message) => {
    expect(() => loadOptions(argv, KEY)).toThrow(OptionsError)
    expect(() => loadOptions(argv, KEY)).toThrow(message)
  })

  it('refuses a deploy key and a missing admin key before anything runs', () => {
    expect(() => loadOptions(['all'], { ...KEY, CONVEX_DEPLOY_KEY: 'prod:abc' })).toThrow(
      'CONVEX_DEPLOY_KEY is set',
    )
    expect(() => loadOptions(['all'], {})).toThrow('QIVO_LOCAL_ADMIN_KEY')
  })
})

/** A client's ModifyQuerySet frame adding `queries` ([id, udfPath, args]). */
const add = (base, next, queries) =>
  JSON.stringify({
    type: 'ModifyQuerySet',
    baseVersion: base,
    newVersion: next,
    modifications: queries.map(([queryId, udfPath, args]) => ({
      type: 'Add',
      queryId,
      udfPath,
      args: [args],
      journal: null,
    })),
  })

/** The server's Transition frame answering `answers` ([id, value]) at set
    version `version`. */
const transition = (version, answers) =>
  JSON.stringify({
    type: 'Transition',
    startVersion: { querySet: version - 1, identity: 0, ts: '0' },
    endVersion: { querySet: version, identity: 0, ts: '1' },
    modifications: answers.map(([queryId, value]) =>
      value instanceof Error
        ? { type: 'QueryFailed', queryId, errorMessage: value.message, logLines: [] }
        : { type: 'QueryUpdated', queryId, value, logLines: [], journal: null },
    ),
  })

describe('the frame tracker', () => {
  it('is current only once every query of the newest set version is answered', () => {
    const tracker = new FrameTracker()
    tracker.sent(
      add(0, 1, [
        [0, 'workspace:root', {}],
        [1, 'tasks:board', { scope: 'p1' }],
      ]),
    )
    expect(tracker.current).toBe(false)
    tracker.received(transition(1, [[0, { orgs: [] }]]))
    expect(tracker.current).toBe(false)
    expect(tracker.waiting).toBe(1)
    tracker.received(transition(1, [[1, { rows: ['a'] }]]))
    expect(tracker.current).toBe(true)
    // a newer set the server has not acknowledged is not current
    tracker.sent(add(1, 2, [[2, 'inbox:summary', {}]]))
    expect(tracker.current).toBe(false)
    tracker.received(transition(2, [[2, { unread: 3 }]]))
    expect(tracker.current).toBe(true)
  })

  it('counts each answer in UTF-8 bytes of its value, and a failure as 0 with its message', () => {
    const tracker = new FrameTracker()
    tracker.sent(
      add(0, 1, [
        [0, 'people:byIds', { ids: ['p'] }],
        [1, 'tasks:board', {}],
      ]),
    )
    tracker.received(
      transition(1, [
        [0, { name: 'Sjöberg' }],
        [1, new Error('too large')],
      ]),
    )
    expect(tracker.set()).toEqual([
      // 18 characters, ö taking two bytes
      { udfPath: 'people:byIds', args: { ids: ['p'] }, bytes: 19 },
      { udfPath: 'tasks:board', args: {}, bytes: 0, error: 'too large' },
    ])
  })

  it('starts the set again on a reconnect, and joins a chunked transition', () => {
    const tracker = new FrameTracker()
    tracker.sent(JSON.stringify({ type: 'Connect', sessionId: 's', connectionCount: 0 }))
    tracker.sent(
      add(0, 1, [
        [0, 'workspace:root', {}],
        [1, 'tasks:board', {}],
      ]),
    )
    tracker.received(
      transition(1, [
        [0, 1],
        [1, 2],
      ]),
    )
    tracker.closed(1006, 'gone')
    tracker.sent(JSON.stringify({ type: 'Connect', sessionId: 's', connectionCount: 1 }))
    tracker.sent(add(0, 1, [[0, 'workspace:root', {}]]))
    expect(tracker.connects).toBe(2)
    expect(tracker.current).toBe(false)
    const whole = transition(1, [[0, { long: 'x'.repeat(40) }]])
    const half = Math.floor(whole.length / 2)
    tracker.received(
      JSON.stringify({
        type: 'TransitionChunk',
        partNumber: 0,
        totalParts: 2,
        chunk: whole.slice(0, half),
      }),
    )
    expect(tracker.current).toBe(false)
    tracker.received(
      JSON.stringify({
        type: 'TransitionChunk',
        partNumber: 1,
        totalParts: 2,
        chunk: whole.slice(half),
      }),
    )
    expect(tracker.current).toBe(true)
    expect(tracker.set().map((query) => query.udfPath)).toEqual(['workspace:root'])
    expect(tracker.closes).toEqual([expect.objectContaining({ code: 1006, reason: 'gone' })])
  })

  it('times each mutation from its frame to its response, and never reads an Authenticate frame', () => {
    let now = 1000
    const tracker = new FrameTracker({ now: () => now })
    tracker.sent(
      JSON.stringify({ type: 'Authenticate', tokenType: 'Admin', value: 'secret', baseVersion: 0 }),
    )
    tracker.sent(
      JSON.stringify({ type: 'Mutation', requestId: 4, udfPath: 'notifications:beat', args: [{}] }),
    )
    expect(tracker.pending.size).toBe(1)
    now = 1042
    tracker.received(
      JSON.stringify({
        type: 'MutationResponse',
        requestId: 4,
        success: true,
        result: null,
        ts: '1',
        logLines: [],
      }),
    )
    expect(tracker.pending.size).toBe(0)
    expect(tracker.calls.get('notifications:beat')).toEqual({ calls: 1, failed: 0, ms: [42] })
    expect(
      JSON.stringify(
        recordedSet({
          view: 'inbox',
          url: '/',
          browser: 'chromium',
          person: {},
          tracker,
          recordedAt: 'now',
        }),
      ),
    ).not.toContain('secret')
  })
})

const NORA = { profile_id: 'prof-nora', auth_user_id: 'auth-nora', org_id: 'org-ns' }
const LEO = { profile_id: 'prof-leo', auth_user_id: 'auth-leo', org_id: 'org-ns' }

/** A recorded set of `queries` recorded as Nora. */
const setOf = (view, queries) => ({
  format: SET_FORMAT,
  view,
  person: NORA,
  queries,
})

describe('the recorded set and the id swap', () => {
  it('writes the format, the person, the sorted queries and the calls by name', () => {
    const tracker = new FrameTracker()
    tracker.sent(
      add(0, 1, [
        [0, 'tasks:board', { scope: 'b' }],
        [1, 'inbox:summary', {}],
      ]),
    )
    tracker.received(
      transition(1, [
        [0, []],
        [1, { n: 1 }],
      ]),
    )
    const set = recordedSet({
      view: 'board',
      url: '/app/x/board/p/2',
      browser: 'webkit',
      person: NORA,
      tracker,
      recordedAt: 't',
    })
    expect(set).toMatchObject({
      format: SET_FORMAT,
      view: 'board',
      browser: 'webkit',
      person: NORA,
      current: true,
      queries: [
        { udfPath: 'inbox:summary', args: {}, bytes: 7 },
        { udfPath: 'tasks:board', args: { scope: 'b' }, bytes: 2 },
      ],
      calls: {},
    })
    expect(checkSet(set)).toBe(set)
  })

  it.each([
    [{ ...setOf('board', [{ udfPath: 'a:b', args: {} }]), format: 'other' }, 'not a recorded set'],
    [
      { ...setOf('board', [{ udfPath: 'a:b', args: {} }]), person: { profile_id: 'p' } },
      'names no person auth_user_id',
    ],
    [setOf('board', []), 'holds no query'],
    [setOf('board', [{ udfPath: 'a:b', args: null }]), 'without a function or arguments'],
  ])('refuses a set that is not whole (%#)', (set, message) => {
    expect(() => checkSet(set)).toThrow(message)
  })

  it("puts the replayed person's profile and login wherever the recorder's stood, keys untouched", () => {
    const set = setOf('mine', [
      {
        udfPath: 'tasks:board',
        args: {
          scope: { mine: 'prof-nora' },
          filters: { owners: ['prof-nora', 'prof-aisha'], search: 'auth-nora' },
          'prof-nora': 1,
        },
        bytes: 10,
      },
      { udfPath: 'workspace:root', args: {}, bytes: 5 },
    ])
    expect(personQueries(set, LEO)).toEqual([
      {
        udfPath: 'tasks:board',
        args: {
          scope: { mine: 'prof-leo' },
          filters: { owners: ['prof-leo', 'prof-aisha'], search: 'auth-leo' },
          'prof-nora': 1,
        },
        bytes: 10,
      },
      { udfPath: 'workspace:root', args: {}, bytes: 5 },
    ])
    // the recorder replays as recorded
    expect(personQueries(set, NORA)).toEqual(set.queries)
  })

  it('swaps an organization only when the person names another', () => {
    expect(
      swapIds({ org_id: 'org-ns', n: 3, ok: true, none: null }, { 'org-ns': 'org-two' }),
    ).toEqual({
      org_id: 'org-two',
      n: 3,
      ok: true,
      none: null,
    })
    const set = setOf('inbox', [{ udfPath: 'inbox:page', args: { org_id: 'org-ns' }, bytes: 1 }])
    expect(personQueries(set, { ...LEO, org_id: undefined })[0].args.org_id).toBe('org-ns')
  })
})

describe('the replay against the tab', () => {
  const recorded = [
    { udfPath: 'inbox:feed', args: { after: 1000 }, bytes: 40 },
    { udfPath: 'tasks:board', args: { scope: 'b', filters: { mine: false } }, bytes: 900 },
  ]

  it('matches the same queries and bytes, with the feed floor compared by presence', () => {
    const replayed = [
      { udfPath: 'tasks:board', args: { filters: { mine: false }, scope: 'b' }, bytes: 900 },
      { udfPath: 'inbox:feed', args: { after: 7777 }, bytes: 40 },
    ]
    expect(compareSets(recorded, replayed)).toMatchObject({ matched: true, missing: [], extra: [] })
  })

  it('fails on other bytes, an argument that differs, a missing query or a failure only one side has', () => {
    expect(compareSets(recorded, [recorded[0], { ...recorded[1], bytes: 899 }]).matched).toBe(false)
    const other = compareSets(recorded, [
      recorded[0],
      { ...recorded[1], args: { scope: 'c', filters: { mine: false } } },
    ])
    expect(other).toMatchObject({
      matched: false,
      missing: ['tasks:board'],
      extra: ['tasks:board'],
    })
    expect(compareSets(recorded, [recorded[1]])).toMatchObject({
      matched: false,
      missing: ['inbox:feed'],
    })
    expect(compareSets(recorded, [recorded[0], { ...recorded[1], error: 'refused' }]).matched).toBe(
      false,
    )
  })

  it("lists one login's subscriptions per organization by function and view", () => {
    const sets = [
      setOf('board', [
        { udfPath: 'workspace:root', args: {}, bytes: 1 },
        { udfPath: 'people:byIds', args: { org_id: 'org-a', ids: [] }, bytes: 1 },
      ]),
      setOf('inbox', [
        { udfPath: 'workspace:root', args: {}, bytes: 1 },
        { udfPath: 'people:byIds', args: { org_id: 'org-a', ids: ['x'] }, bytes: 1 },
        { udfPath: 'inbox:page', args: { org_id: 'org-b' }, bytes: 1 },
      ]),
    ]
    expect(subscriptionsByOrganization(sets)).toEqual({
      login: { 'workspace:root': { queries: 2, views: ['board', 'inbox'] } },
      'org-a': { 'people:byIds': { queries: 2, views: ['board', 'inbox'] } },
      'org-b': { 'inbox:page': { queries: 1, views: ['inbox'] } },
    })
  })
})

/** A function log completion as the local backend streams it, times in seconds. */
const completion = (
  identifier,
  { start, js, total = js, udfType = 'Query', nested = false, cached = false, error = null },
) => ({
  kind: 'Completion',
  identifier,
  udfType,
  executionTimestamp: start,
  timestamp: start + total,
  userExecutionTime: js,
  executionTime: total,
  cachedResult: cached,
  parentExecutionId: nested ? 'parent' : null,
  usageStats: { databaseReadDocuments: 3, databaseReadBytes: 300 },
  error,
})

describe('the per-function statistics', () => {
  it('reads a completion in milliseconds and skips other entries', () => {
    expect(
      logEntry(completion('tasks.js:board', { start: 10, js: 0.012, total: 0.02 })),
    ).toMatchObject({
      fn: 'tasks:board',
      kind: 'Query',
      start: 10_000,
      end: 10_020,
      js_ms: 12,
      total_ms: 20,
      read_documents: 3,
    })
    expect(logEntry({ kind: 'Console', identifier: 'x' })).toBeNull()
  })

  it('takes nearest-rank percentiles', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(sorted, 0.5)).toBe(50)
    expect(percentile(sorted, 0.99)).toBe(99)
    expect(percentile([7], 0.99)).toBe(7)
    expect(percentile([], 0.5)).toBeNull()
    expect(spread([3, 1, 2, null])).toEqual({ count: 3, p50: 2, p99: 3, max: 3 })
  })

  it('counts top-level calls per function a second, times only those that ran, and sums the total', () => {
    const entries = [
      completion('tasks.js:board', { start: 0, js: 0.01, total: 0.03 }),
      completion('tasks.js:board', { start: 1, js: 0.6, total: 0.7 }),
      completion('tasks.js:board', { start: 2, js: 0, cached: true }),
      completion('lib.js:inner', { start: 1, js: 0.4, nested: true }),
      completion('issues.js:update', { start: 3, js: 0.02, udfType: 'Mutation', error: 'refused' }),
    ].map(logEntry)
    const stats = functionStats(entries, 2)
    expect(Object.keys(stats.functions)).toEqual(['issues:update', 'tasks:board'])
    expect(stats.functions['tasks:board']).toMatchObject({
      kind: 'Query',
      executions: 3,
      per_second: 1.5,
      cached: 1,
      failed: 0,
      js_ms: { count: 2, p50: 10, p99: 600, max: 600 },
      total_ms_sum: 730,
    })
    expect(stats.functions['issues:update']).toMatchObject({ failed: 1, per_second: 0.5 })
    expect(stats.backend_total_ms).toBe(750)
    expect(overLine(stats)).toEqual([{ fn: 'tasks:board', js_ms_max: 600 }])
    expect(overLine(stats, 1000)).toEqual([])
  })

  it("gives an idle phase per session per minute, and the backend's own jobs per minute apart", () => {
    const entries = [
      completion('notifications.js:beat', { start: 0, js: 0.02, total: 0.03, udfType: 'Mutation' }),
      completion('notifications.js:beat', {
        start: 30,
        js: 0.04,
        total: 0.05,
        udfType: 'Mutation',
      }),
      completion('crons.js:sweep', { start: 10, js: 0.1, udfType: 'Mutation' }),
    ].map(logEntry)
    const idle = {
      ...functionStats(entries, 120),
      bytes_total: 4000,
      answers: { 'inbox:feed': { updates: 8, bytes: 0 } },
      client_calls: { 'notifications:beat': { calls: 2 } },
    }
    expect(perSessionMinute(idle, 2, 120, new Set(['notifications:beat']))).toEqual({
      bytes: 1000,
      answers: 2,
      executions: 0.5,
      js_ms: 15,
      total_ms: 20,
      functions: { 'notifications:beat': { executions: 0.5, js_ms: 15, total_ms: 20 } },
      calls: { 'notifications:beat': 0.5 },
      backend_jobs_per_minute: { 'crons:sweep': { executions: 0.5, js_ms: 50 } },
    })
  })

  it('finds the most calls at once, with touching calls counted apart', () => {
    expect(
      mostAtOnce([
        { start: 0, end: 10 },
        { start: 5, end: 15 },
        { start: 6, end: 7 },
      ]),
    ).toBe(3)
    expect(
      mostAtOnce([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
      ]),
    ).toBe(1)
    expect(mostAtOnce([])).toBe(0)
  })

  it('reads steal and busy shares from /proc/stat', () => {
    const a = cpuCounters('cpu  100 0 100 700 0 0 0 100 0 0\ncpu0 1 2 3')
    const b = cpuCounters('cpu  200 0 200 800 0 0 0 200 0 0')
    expect(a).toEqual({ total: 1000, idle: 700, steal: 100 })
    expect(cpuShare(a, b)).toEqual({ steal_pct: 25, busy_pct: 50, ticks: 400 })
    expect(cpuCounters('intr 5')).toBeNull()
    expect(cpuShare(a, null)).toBeNull()
  })
})

describe('the output', () => {
  it('names its format, its sources and every part of a rung', () => {
    const report = rungReport({
      rung: { clients: 10 },
      recorded: [],
      match: { matched: true },
      phases: { idle: {} },
      subscriptions: { login: 'nora', by_organization: {} },
      notRun: { changes: 'not asked' },
    })
    expect(report.format).toBe(REPORT_FORMAT)
    expect(Object.keys(report)).toEqual([
      'format',
      'rung',
      'sources',
      'recorded',
      'match',
      'phases',
      'subscriptions',
      'not_run',
    ])
    expect(Object.keys(report.sources)).toEqual([
      'functions',
      'client_ms',
      'bytes',
      'backend_at_once',
      'in_flight',
      'steal',
    ])
    expect(report.sources.functions).toContain('drops entries')
    expect(report.not_run).toEqual({ changes: 'not asked' })
  })
})
