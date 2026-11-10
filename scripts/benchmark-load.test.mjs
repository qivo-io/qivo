import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALERT_WINDOW_MS, LIMITS } from '../convex/lib/limits'
import { createNotificationFeed } from '../src/lib/notificationFeed'
import { startNotificationLeader } from '../src/lib/notificationLeader'
import { leadAlerts } from './load/alerts.mjs'
import {
  CHANGE_KINDS,
  COMMENT_RATE_MAX,
  COMMENTS_PER_MINUTE,
  commentTargets,
  mostInAMinute,
} from './load/changes.mjs'
import {
  checkSet,
  compareSets,
  FrameTracker,
  personQueries,
  recordedSet,
  SET_FORMAT,
  subscriptionsByOrganization,
  swapIds,
  withoutLeaderReads,
} from './load/frames.mjs'
import {
  DEFAULT_PHASES,
  EVERYDAY_ORG,
  loadOptions,
  OptionsError,
  PARTS,
  VIEWS,
} from './load/options.mjs'
import { everydayAssignments } from './load/plan.mjs'
import {
  cpuCounters,
  cpuShare,
  firstAnswerStats,
  functionStats,
  idleShares,
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
      phases: DEFAULT_PHASES,
      people: EVERYDAY_ORG.people,
      tasksEach: 3,
      orgs: 1,
      busyLoops: 8,
      busyCpus: null,
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

  it('takes the tabs part, which all leaves out, with its tabs and the top-level Board', () => {
    expect(loadOptions(['all'], KEY)).toMatchObject({ tabs: 1, boardTop: false })
    expect(loadOptions(['all'], KEY).parts).not.toContain('tabs')
    expect(loadOptions(['tabs', '--tabs', '10', '--board-top'], KEY)).toMatchObject({
      parts: ['tabs'],
      tabs: 10,
      boardTop: true,
    })
    expect(() => loadOptions(['tabs', '--tabs', '0'], KEY)).toThrow('--tabs takes a whole number')
  })

  it('keeps the phases in the order given and takes the organizations and the busy loops', () => {
    const options = loadOptions(
      [
        'replay',
        '--phases',
        'startup,idle,changes,reconnect,busy',
        '--orgs',
        '5',
        '--clients',
        '100',
        '--busy-loops',
        '8',
        '--busy-cpus',
        '0-3,6',
      ],
      KEY,
    )
    expect(options).toMatchObject({
      phases: ['startup', 'idle', 'changes', 'reconnect', 'busy'],
      orgs: 5,
      busyLoops: 8,
      busyCpus: '0-3,6',
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
    [['replay', '--clients', '4', '--processes', '1', '--orgs', '5'], '--orgs 5 is more than'],
    [['replay', '--busy-cpus', 'all'], '--busy-cpus takes a CPU list'],
    [['replay', '--busy-cpus', '0-7;rm'], '--busy-cpus takes a CPU list'],
    [['replay', '--phases', 'idle,soak'], '--phases takes a comma list'],
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

  it('times each query from its Add to its first answer, leaving out one that has none', () => {
    let now = 1000
    const tracker = new FrameTracker({ now: () => now })
    tracker.sent(
      add(0, 1, [
        [0, 'workspace:root', {}],
        [1, 'tasks:board', {}],
      ]),
    )
    now = 1040
    tracker.received(transition(1, [[0, { orgs: [] }]]))
    now = 1300
    // a later answer does not move the first one
    tracker.received(transition(1, [[0, { orgs: [1] }]]))
    expect(tracker.firstAnswers()).toEqual([['workspace:root', 40]])
    const stats = firstAnswerStats([
      ['workspace:root', 40],
      ['tasks:board', 120],
      ['workspace:root', 60],
    ])
    expect(stats.all).toEqual({ count: 3, p50: 60, p99: 120, max: 120 })
    expect(stats.functions['workspace:root']).toEqual({ count: 2, p50: 40, p99: 60, max: 60 })
    expect(Object.keys(stats.functions)).toEqual(['tasks:board', 'workspace:root'])
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

  it("swaps a mirrored organization's ids and leaves out the recorder's other seats", () => {
    const set = setOf('board', [
      { udfPath: 'tasks:board', args: { org_id: 'org-ns', project_id: 'proj-ns' }, bytes: 9 },
      { udfPath: 'inbox:summary', args: { org_id: 'org-other' }, bytes: 3 },
      { udfPath: 'workspace:root', args: {}, bytes: 5 },
    ])
    const two = { profile_id: 'prof-ida', auth_user_id: 'auth-ida', org_id: 'org-two' }
    expect(personQueries(set, two, { more: { 'proj-ns': 'proj-two' }, ownOrg: true })).toEqual([
      { udfPath: 'tasks:board', args: { org_id: 'org-two', project_id: 'proj-two' }, bytes: 9 },
      { udfPath: 'workspace:root', args: {}, bytes: 5 },
    ])
    // without ownOrg the other seat's read stays, as the recorder holds it
    expect(personQueries(set, LEO).map((query) => query.udfPath)).toContain('inbox:summary')
  })

  it("drops only the leader's reads for a tab that does not lead", () => {
    const queries = [
      { udfPath: 'inbox:feed', args: { after: 1 } },
      { udfPath: 'notifications:settings', args: {} },
      { udfPath: 'inbox:summary', args: {} },
    ]
    expect(withoutLeaderReads(queries)).toEqual([{ udfPath: 'inbox:summary', args: {} }])
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
    expect(stats.functions['issues:update']).toMatchObject({
      failed: 1,
      per_second: 0.5,
      errors: [{ error: 'refused', count: 1 }],
    })
    expect(stats.functions['tasks:board'].errors).toEqual([])
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

describe('the changes plan', () => {
  it("follows the app's comment rule and posts a comment every fourth change", () => {
    expect(COMMENT_RATE_MAX).toBe(LIMITS.commentRate.max)
    expect(CHANGE_KINDS).toEqual(['rename', 'move', 'status', 'comment'])
    expect(COMMENTS_PER_MINUTE).toBe(15)
  })

  it('spreads the comments so two runs back to back stay under the rule on every task', () => {
    const tasks = ['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => ({ id }))
    const targets = commentTargets(tasks)
    expect(targets.map((task) => task.id)).toEqual(['t1', 't2', 't3', 't4'])
    expect(2 * mostInAMinute(targets.length)).toBeLessThanOrEqual(COMMENT_RATE_MAX)
    // one task, as the first tool had it, takes every comment: 15 a minute
    expect(mostInAMinute(1)).toBeGreaterThan(COMMENT_RATE_MAX)
  })

  it('refuses a Board with too few other open tasks rather than post comments the rule refuses', () => {
    expect(() => commentTargets([{ id: 't1' }, { id: 't2' }, { id: 't3' }])).toThrow(
      'fewer than the 4 the comments need',
    )
  })
})

describe("the replayed leader, the app's own alert client", () => {
  const T0 = 1_800_000_000_000
  const app = { createNotificationFeed, startNotificationLeader }

  /* A stand-in ConvexClient: beats answer the server time `server.now`
     every minute, claims grant what they offer, and every watch is kept
     with its floor, so a test answers the feed and reads what the leader
     subscribed. */
  function standIn({ summarizeFirst = false } = {}) {
    const server = { now: T0, connection: 1 }
    let covered = !summarizeFirst
    const calls = []
    const watches = []
    const convex = {
      connectionState: () => ({ isWebSocketConnected: true }),
      async mutation(fn, args) {
        const name = getFunctionName(fn)
        calls.push(name)
        if (name === 'notifications:beat') return { now: server.now, every_ms: 60_000 }
        if (name === 'notifications:claimSummary') {
          covered = true
          return { state: 'none' }
        }
        if (!covered) return { state: 'summarize_first' }
        return { state: 'granted', keys: args.events.map((event) => event.key), limited: false }
      },
      onUpdate(fn, args, answer) {
        const watch = { name: getFunctionName(fn), args, answer, stopped: false }
        watches.push(watch)
        if (watch.name === 'notifications:settings') answer({ delivery: 'recent' })
        return () => {
          watch.stopped = true
        }
      },
    }
    const feeds = () => watches.filter((watch) => watch.name === 'inbox:feed')
    const floors = () => feeds().map((watch) => watch.args.after - T0)
    const live = () => feeds().filter((watch) => !watch.stopped)
    const stop = leadAlerts({ convex, connection: () => server.connection, app, name: 'test' })
    return { server, calls, watches, floors, live, stop }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('watches the feed again at each beat while no event holds its floor, as a quiet tab does', async () => {
    const run = standIn()
    await vi.advanceTimersByTimeAsync(0)
    expect(run.calls).toEqual(['notifications:beat'])
    expect(run.floors()).toEqual([-ALERT_WINDOW_MS])
    // the baseline: an answer with no event, claimed with nothing offered
    run.live()[0].answer({ events: [], through: T0 - ALERT_WINDOW_MS, more: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(run.calls).toEqual(['notifications:beat', 'notifications:claimAlerts'])
    run.server.now = T0 + 60_000
    await vi.advanceTimersByTimeAsync(60_000)
    // the beat a minute later raised the floor, and the feed is watched again
    expect(run.floors()).toEqual([-ALERT_WINDOW_MS, 60_000 - ALERT_WINDOW_MS])
    expect(run.live()).toHaveLength(1)
    run.stop()
  })

  it('keeps a floor that an event under ten minutes old holds through the next beat', async () => {
    const run = standIn()
    await vi.advanceTimersByTimeAsync(0)
    const at = T0 - 120_000
    run.live()[0].answer({ events: [{ key: 'm1', at, kind: 'change' }], through: at, more: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(run.floors()).toEqual([-ALERT_WINDOW_MS, -120_000])
    run.server.now = T0 + 60_000
    await vi.advanceTimersByTimeAsync(60_000)
    // the beat answered, but the floor stays at the event's time
    expect(run.calls.filter((name) => name === 'notifications:beat')).toHaveLength(2)
    expect(run.floors()).toEqual([-ALERT_WINDOW_MS, -120_000])
    run.stop()
  })

  it("moves the floor to the beat's time when another session of the person claimed last", async () => {
    // a new browser session of a person whose other session moved the
    // checkpoint, as the closing review's tabs after the record part
    const run = standIn({ summarizeFirst: true })
    await vi.advanceTimersByTimeAsync(0)
    run.live()[0].answer({ events: [], through: T0 - ALERT_WINDOW_MS, more: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(run.calls).toEqual([
      'notifications:beat',
      'notifications:claimAlerts',
      'notifications:beat',
      'notifications:claimSummary',
      'notifications:claimAlerts',
    ])
    expect(run.floors()).toEqual([-ALERT_WINDOW_MS, 0])
    // so for ten minutes no beat raises it, and the feed is watched no more
    for (let minute = 1; minute < 10; minute++) {
      run.server.now = T0 + minute * 60_000
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(run.floors()).toEqual([-ALERT_WINDOW_MS, 0])
    run.server.now = T0 + 11 * 60_000
    await vi.advanceTimersByTimeAsync(120_000)
    expect(run.floors().at(-1)).toBe(11 * 60_000 - ALERT_WINDOW_MS)
    run.stop()
  })

  it('runs the resume order after a reconnect: a beat, the summary, then the feed from that beat', async () => {
    const run = standIn()
    await vi.advanceTimersByTimeAsync(0)
    run.live()[0].answer({ events: [], through: T0 - ALERT_WINDOW_MS, more: false })
    await vi.advanceTimersByTimeAsync(0)
    run.server.connection = 2
    run.server.now = T0 + 10_000
    vi.setSystemTime(T0 + 10_000)
    run.calls.length = 0
    // the first answer on the new connection
    run.live()[0].answer({ events: [], through: T0 - ALERT_WINDOW_MS, more: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(run.calls).toEqual(['notifications:beat', 'notifications:claimSummary'])
    expect(run.floors().at(-1)).toBe(10_000)
    run.stop()
    expect(run.live()).toHaveLength(0)
  })
})

describe("the idle phase's shares", () => {
  it("splits a leader's beats, claims and own reads from the views' answers", () => {
    const idle = {
      answers: {
        'inbox:feed': { updates: 4, bytes: 200 },
        'notifications:settings': { updates: 0, bytes: 0 },
        'tasks:board': { updates: 10, bytes: 5000 },
      },
      client_calls: {
        'notifications:beat': { calls: 4 },
        'notifications:claimAlerts': { calls: 2 },
      },
    }
    // two leaders of four sessions over two minutes
    expect(idleShares(idle, { sessions: 4, leaders: 2, seconds: 120 })).toEqual({
      leader: {
        sessions: 2,
        'notifications:beat': 1,
        'notifications:claimAlerts': 0.5,
        'notifications:claimSummary': 0,
        answers: {
          'inbox:feed': { answers: 1, bytes: 50 },
          'notifications:settings': { answers: 0, bytes: 0 },
        },
      },
      views: { sessions: 4, answers: 1.25, bytes: 625 },
    })
    // no leader: nothing is divided by zero
    expect(idleShares(idle, { sessions: 4, leaders: 0, seconds: 60 }).leader).toMatchObject({
      sessions: 0,
      'notifications:beat': 0,
    })
  })
})

describe("setup's everyday people", () => {
  const task = (id, assignee_id, extra = {}) => ({ id, assignee_id, status: 'todo', ...extra })

  it("gives each added person open tasks of the seed's other people, never Nora's", () => {
    const tasks = [
      task('t5', 'leo'),
      task('t1', 'nora'),
      task('t2', 'aisha', { status: 'done' }),
      task('t3', 'leo', { status: 'review' }),
      task('t4', 'leo', { has_subtasks: true }),
      task('t6', 'leo', { parent_id: 't5' }),
      task('t7', null),
      task('t8', 'emil', { status: 'progress' }),
      task('t9', 'emil', { status: 'backlog' }),
    ]
    expect(everydayAssignments(['p1', 'p2'], tasks, 2, 'nora')).toEqual({
      pairs: [
        ['t5', 'p1'],
        ['t7', 'p1'],
        ['t8', 'p2'],
        ['t9', 'p2'],
      ],
      short: [],
    })
  })

  it('counts what an earlier run assigned and names the people left short', () => {
    const tasks = [task('t1', 'p1'), task('t2', 'leo'), task('t3', 'leo')]
    // p1 holds one already, so one more; p2 gets the last; p3 none
    expect(everydayAssignments(['p1', 'p2', 'p3'], tasks, 2, 'nora')).toEqual({
      pairs: [
        ['t2', 'p1'],
        ['t3', 'p2'],
      ],
      short: ['p2', 'p3'],
    })
    expect(everydayAssignments(['p1'], tasks, 0, 'nora')).toEqual({ pairs: [], short: [] })
  })
})
