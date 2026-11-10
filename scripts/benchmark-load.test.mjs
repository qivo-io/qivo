import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALERT_WINDOW_MS, LIMITS } from '../convex/lib/limits'
import { createNotificationFeed } from '../src/lib/notificationFeed'
import { startNotificationLeader } from '../src/lib/notificationLeader'
import { leadAlerts } from './load/alerts.mjs'
import { busyLoops } from './load/busy.mjs'
import {
  CHANGE_KINDS,
  COMMENT_RATE_MAX,
  COMMENTS_PER_MINUTE,
  changeWrites,
  commentTargets,
  mostInAMinute,
} from './load/changes.mjs'
import {
  checkSet,
  checkSetsDay,
  compareSets,
  FrameTracker,
  localDay,
  personQueries,
  recordedSet,
  SET_FORMAT,
  subscriptionsByOrganization,
  withoutLeaderReads,
} from './load/frames.mjs'
import {
  EVERYDAY_ORG,
  loadOptions,
  OPTIONS,
  OptionsError,
  PARTS,
  PHASES,
  usage,
  VIEWS,
} from './load/options.mjs'
import {
  checkSpecs,
  clientSpecs,
  everydayAssignments,
  findSeat,
  holdPlaces,
  stableId,
  teamsOfPerson,
  viewUrls,
} from './load/plan.mjs'
import {
  attachResends,
  cpuCounters,
  cpuShare,
  firstAnswerStats,
  functionStats,
  hostedModel,
  idleShares,
  logCoverage,
  logEntry,
  mergeCalls,
  mergeCounts,
  mostAtOnce,
  noisyOf,
  overLine,
  pacingTrigger,
  percentile,
  perSessionMinute,
  phaseFigures,
  REPORT_FORMAT,
  rungReport,
  spread,
  tabResends,
  tabsIdlePerMinute,
  watchedPerMinute,
} from './load/report.mjs'

/* The combined load benchmark's pure parts (scripts/benchmark-load.mjs):
   its options and help text, the Convex frames it reads, the recorded
   set's format, what another person replays of a set, setup's plan,
   which client replays what and the check of other organizations' ids,
   the changes' comments, the replayed leader's
   wiring of the app's alert client, the per-function and per-phase
   figures and the output's shape, and the busy phase's loops, the one
   part here that starts processes. */

const KEY = { QIVO_LOCAL_ADMIN_KEY: 'local-admin-key' }

describe('the load benchmark options', () => {
  it('runs setup, record and replay for all, with the everyday organization and 10 clients', () => {
    const options = loadOptions(['all'], KEY)
    expect(options.parts).toEqual(['setup', 'record', 'replay'])
    expect(options).toMatchObject({
      url: 'http://127.0.0.1:3236',
      siteUrl: 'http://localhost:5241',
      browser: 'chromium',
      views: VIEWS,
      phases: PHASES.replay.default,
      people: EVERYDAY_ORG.people,
      teams: EVERYDAY_ORG.teams,
      tasksEach: EVERYDAY_ORG.tasksEach,
      orgs: 1,
      clients: 10,
      processes: 2,
      busyLoops: 8,
      busyCpus: null,
      noHiddenTab: false,
      boardTop: false,
      adminKey: 'local-admin-key',
    })
  })

  it('takes one part with the options it reads and a loopback backend', () => {
    const options = loadOptions(
      [
        'replay',
        '--url',
        'http://localhost:3210/',
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
      phases: ['idle'],
      clients: 100,
      processes: 4,
      noHiddenTab: true,
    })
    expect(
      loadOptions(['record', '--views', 'board,inbox,board', '--board-top'], KEY),
    ).toMatchObject({ views: ['board', 'inbox'], boardTop: true })
    expect(loadOptions(['setup', '--tasks-each', '0'], KEY).tasksEach).toBe(0)
  })

  it('takes the tabs part, which all leaves out, with its own phases', () => {
    expect(loadOptions(['all'], KEY).parts).not.toContain('tabs')
    expect(loadOptions(['tabs', '--tabs', '10'], KEY)).toMatchObject({
      parts: ['tabs'],
      tabs: 10,
      phases: PHASES.tabs.default,
    })
    expect(() => loadOptions(['tabs', '--phases', 'match,idle'], KEY)).toThrow(
      '--phases of tabs takes startup, changes, reconnect, idle, not match',
    )
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
    // setup's organizations do not wait for the replay's clients
    expect(loadOptions(['setup', '--orgs', '20'], KEY).orgs).toBe(20)
  })

  it.each([
    [['measure'], 'The first argument is the part'],
    [['record', '--url', 'https://happy-otter-123.convex.cloud'], 'loopback origin'],
    [['record', '--url', 'http://10.0.0.5:3236'], 'loopback origin'],
    [['record', '--site-url', 'https://qivo.io'], 'loopback origin'],
    // lookalikes a pattern without its end, or without a port check, would let through
    [['record', '--url', 'http://localhost.example.com:3236'], 'loopback origin'],
    [['record', '--url', 'http://127.0.0.1:3236@happy-otter-123.convex.cloud'], 'loopback origin'],
    [['record', '--url', 'http://127.0.0.1:99999'], 'loopback origin'],
    [['record', '--site-url', 'http://localhost:5241/app'], 'loopback origin'],
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
    [['replay', '--client', '100'], '--client is no option of the benchmark'],
    [['replay', 'extra'], 'extra is no option of the benchmark'],
    [['replay', '--views', 'board'], '--views is an option of record, tabs, not of replay'],
    [['setup', '--clients', '100'], '--clients is an option of replay, not of setup'],
    [['replay', '--output', '--clients'], '--output takes a value'],
  ])('refuses %j', (argv, message) => {
    expect(() => loadOptions(argv, KEY)).toThrow(OptionsError)
    expect(() => loadOptions(argv, KEY)).toThrow(message)
  })

  it('refuses a deploy key, a hosted environment and a missing or hosted-shaped admin key before anything runs', () => {
    expect(() => loadOptions(['all'], { ...KEY, CONVEX_DEPLOY_KEY: 'prod:abc' })).toThrow(
      'CONVEX_DEPLOY_KEY is set',
    )
    expect(() => loadOptions(['all'], {})).toThrow('QIVO_LOCAL_ADMIN_KEY')
    for (const key of ['prod:happy-otter-123|secret', 'dev:x|y', 'preview:a', 'project:b', 'a b'])
      expect(() => loadOptions(['all'], { QIVO_LOCAL_ADMIN_KEY: key })).toThrow(
        'not a deploy key or another hosted key',
      )
    for (const env of [
      { QIVO_ENVIRONMENT: 'staging' },
      { QIVO_ENVIRONMENT: 'production' },
      { QIVO_ENVIRONMENT: 'demo' },
      { APP_MODE: 'demo' },
    ])
      expect(() => loadOptions(['all'], { ...KEY, ...env })).toThrow(
        'refuses a staging, production or demo environment',
      )
    // a local backend's own key in a development environment runs
    expect(loadOptions(['all'], { ...KEY, QIVO_ENVIRONMENT: 'development' }).adminKey).toBe(
      'local-admin-key',
    )
  })

  it('answers --help without a key, and its text names every part and option with its parts', () => {
    expect(loadOptions(['--help'], {})).toEqual({ help: true })
    expect(loadOptions(['replay', '-h'], {})).toEqual({ help: true })
    const text = usage()
    for (const part of Object.keys(PARTS)) expect(text).toContain(`  ${part} `)
    for (const [name, spec] of Object.entries(OPTIONS)) {
      expect(text).toContain(`--${name}`)
      expect(text).toContain(`[${spec.parts.join(', ')}]`)
      // every option the parser reads has a key, and each key is the parser's
      expect(loadOptions(['all'], KEY)).toHaveProperty(spec.key)
    }
    expect(text).toContain('--clients <n>')
    expect(text).toContain('(10)')
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

  it('counts a call in the phase that sent it, not the one its slow answer reaches', () => {
    let now = 1000
    const tracker = new FrameTracker({ now: () => now })
    const call = (requestId) =>
      JSON.stringify({ type: 'Mutation', requestId, udfPath: 'notifications:beat', args: [{}] })
    const answer = (requestId) =>
      JSON.stringify({ type: 'MutationResponse', requestId, success: true, ts: '1', logLines: [] })
    tracker.sent(call(1))
    // a new phase starts while the beat waits; its log holds the beat in the old one
    now = 2000
    tracker.calls.clear()
    tracker.callsSince = now
    tracker.sent(call(2))
    now = 6000
    tracker.received(answer(1))
    tracker.received(answer(2))
    expect(tracker.calls.get('notifications:beat')).toEqual({ calls: 1, failed: 0, ms: [4000] })
    expect(tracker.pending.size).toBe(0)
  })

  it('records when its newest set became current, and forgets it while a newer set waits', () => {
    let now = 1000
    const tracker = new FrameTracker({ now: () => now })
    tracker.sent(add(0, 1, [[0, 'workspace:root', {}]]))
    expect(tracker.currentSince).toBeNull()
    now = 1040
    tracker.received(transition(1, [[0, { orgs: [] }]]))
    expect(tracker.currentSince).toBe(1040)
    // a later answer while current keeps the moment it became current
    now = 1300
    tracker.received(transition(1, [[0, { orgs: [1] }]]))
    expect(tracker.currentSince).toBe(1040)
    // a view's second wave of reads makes it wait again, then current anew
    now = 1400
    tracker.sent(add(1, 2, [[1, 'tasks:board', {}]]))
    expect(tracker.currentSince).toBeNull()
    now = 1650
    tracker.received(transition(2, [[1, { rows: [] }]]))
    expect(tracker.currentSince).toBe(1650)
  })

  it('says whether its set holds an answered query of a function', () => {
    const tracker = new FrameTracker()
    tracker.sent(
      add(0, 1, [
        [0, 'workspace:root', {}],
        [1, 'inbox:feed', { after: 1 }],
      ]),
    )
    tracker.received(transition(1, [[0, { orgs: [] }]]))
    expect(tracker.holds('workspace:root')).toBe(true)
    // added but not answered yet, as a leader's feed right after its first beat
    expect(tracker.holds('inbox:feed')).toBe(false)
    expect(tracker.holds('tasks:board')).toBe(false)
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

describe('the recorded set and what another person replays of it', () => {
  it('writes the format, the person, the sorted queries and the calls by name', () => {
    const tracker = new FrameTracker()
    tracker.sent(
      add(0, 1, [
        [0, 'tasks:board', { scope: 'b' }],
        [1, 'inbox:summary', {}],
        [2, 'workspace:root', {}],
      ]),
    )
    tracker.received(
      transition(1, [
        [0, []],
        [1, { n: 1 }],
        [2, {}],
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
        { udfPath: 'workspace:root', args: {}, bytes: 2 },
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
    // every tab subscribes the root part, whose answer starts a leader's alerts
    [setOf('board', [{ udfPath: 'tasks:board', args: {} }]), 'holds no root part'],
  ])('refuses a set that is not whole (%#)', (set, message) => {
    expect(() => checkSet(set)).toThrow(message)
  })

  it('keeps the recorded ids, so a person already among the owners is not doubled and the recorder stays where she is data', () => {
    const set = setOf('roadmap', [
      {
        udfPath: 'planning:ownerLoads',
        args: { org_id: 'org-ns', owner_ids: ['prof-aaa', 'prof-leo', 'prof-nora'] },
        bytes: 10,
      },
      { udfPath: 'people:byIds', args: { ids: ['prof-leo', 'prof-aisha'] }, bytes: 6 },
      { udfPath: 'workspace:root', args: {}, bytes: 5 },
    ])
    const leos = personQueries(set, LEO)
    expect(leos).toEqual(set.queries)
    // the first tool's swap gave ['prof-aaa', 'prof-leo', 'prof-leo']
    expect(leos[0].args.owner_ids).toEqual(['prof-aaa', 'prof-leo', 'prof-nora'])
    expect(personQueries(set, NORA)).toEqual(set.queries)
  })

  it('refuses My view to anyone but its recorder, and a set to a person of another organization', () => {
    const mine = setOf('mine', [
      { udfPath: 'planning:ownerLoads', args: { org_id: 'org-ns', owner_ids: ['prof-nora'] } },
    ])
    expect(() => personQueries(mine, LEO)).toThrow('only its recorder replays it')
    expect(personQueries(mine, NORA)).toEqual(mine.queries)
    const board = setOf('board', [{ udfPath: 'workspace:root', args: {} }])
    expect(() => personQueries(board, { ...LEO, org_id: 'org-two' })).toThrow(
      'recorded in organization org-ns, not in org-two',
    )
  })

  it("leaves out the recorder's other seats for a person with one seat", () => {
    const set = setOf('board', [
      { udfPath: 'tasks:board', args: { org_id: 'org-ns', project_id: 'proj-ns' }, bytes: 9 },
      { udfPath: 'inbox:summary', args: { org_id: 'org-other' }, bytes: 3 },
      { udfPath: 'workspace:root', args: {}, bytes: 5 },
    ])
    expect(personQueries(set, LEO, { ownOrg: true }).map((query) => query.udfPath)).toEqual([
      'tasks:board',
      'workspace:root',
    ])
    // without ownOrg the other seat's read stays, as the recorder holds it
    expect(personQueries(set, LEO).map((query) => query.udfPath)).toContain('inbox:summary')
  })

  it("refuses sets recorded on another local day, whose dated arguments are that day's", () => {
    const at = (day, hour) => new Date(2026, 10, day, hour, 30)
    const board = { ...setOf('board', []), recorded_at: at(10, 23).toISOString() }
    expect(localDay(at(10, 23))).toBe('2026-11-10')
    expect(checkSetsDay([board], at(10, 0))).toEqual([board])
    // just past midnight the daily image and the Overview's day are another day's
    expect(() => checkSetsDay([board], at(11, 0))).toThrow(
      'the recorded sets board (2026-11-10) were recorded on another day than today, 2026-11-11',
    )
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
      no_org_argument: { 'workspace:root': { queries: 2, views: ['board', 'inbox'] } },
      'org-a': { 'people:byIds': { queries: 2, views: ['board', 'inbox'] } },
      'org-b': { 'inbox:page': { queries: 1, views: ['inbox'] } },
    })
  })

  it("reads an organization in a query's scope, and one a project-only read names by its ids", () => {
    const board = setOf('board', [
      {
        udfPath: 'tasks:board',
        args: { scope: { kind: 'project', org_id: 'org-b', project_id: 'proj-b' } },
      },
      { udfPath: 'projectNav:byIds', args: { ids: ['proj-b'] } },
      { udfPath: 'projectNav:children', args: { project_id: 'proj-a' } },
      { udfPath: 'projectNav:page', args: {} },
    ])
    const idOrgs = new Map([
      ['proj-a', 'org-a'],
      ['proj-b', 'org-b'],
    ])
    expect(subscriptionsByOrganization([board], idOrgs)).toEqual({
      no_org_argument: { 'projectNav:page': { queries: 1, views: ['board'] } },
      'org-a': { 'projectNav:children': { queries: 1, views: ['board'] } },
      'org-b': {
        'projectNav:byIds': { queries: 1, views: ['board'] },
        'tasks:board': { queries: 1, views: ['board'] },
      },
    })
    // a person with one seat leaves out another organization's read in a scope too
    const two = setOf('board', [
      ...board.queries,
      { udfPath: 'overview:summary', args: { scope: { kind: 'project', org_id: 'org-ns' } } },
    ])
    expect(
      personQueries({ ...two, person: { ...NORA, org_id: 'org-ns' } }, LEO, { ownOrg: true }).map(
        (query) => query.udfPath,
      ),
    ).toEqual(['projectNav:byIds', 'projectNav:children', 'projectNav:page', 'overview:summary'])
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

  it('marks a phase noisy from 10% steal, and unknown where the steal could not be read', () => {
    expect(noisyOf({ steal_pct: 9.9 })).toBe(false)
    expect(noisyOf({ steal_pct: 10 })).toBe(true)
    expect(noisyOf(null)).toBeNull()
    // the phase's figures carry it, never false for an unread /proc/stat
    expect(phaseFigures([], 1, [], { steal: null }).noisy).toBeNull()
    expect(phaseFigures([], 1, [], { steal: { steal_pct: 12.5 } }).noisy).toBe(true)
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
      'idle',
      'backend_at_once',
      'in_flight',
      'steal',
      'event_loop_lag',
      'pacing_trigger',
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

  it('puts back what landed, a move or status change whose return write failed included', () => {
    const tasks = {
      org: 'org',
      renamed: { id: 'r', title: 'Calibrate', status: 'todo' },
      moved: { id: 'm' },
      home: 'home',
      sibling: { id: 'sib' },
      commented: [{ id: 'c' }],
    }
    const writes = changeWrites(tasks)
    // a rename, a move out, a status change to In progress and a comment land
    for (const i of [0, 1, 2]) writes.next(i).landed()
    const comment = writes.next(3)
    comment.landed()
    writes.next(4).landed()
    // the move back, the status change back and the next comment fail
    expect(writes.next(5).args.project_id).toBe('home')
    expect(writes.next(6).args.patch).toEqual({ status: 'todo' })
    writes.next(7)
    expect(writes.restores()).toEqual([
      ['issues:update', { org_id: 'org', id: 'r', patch: { title: 'Calibrate' } }],
      ['issues:update', { org_id: 'org', id: 'r', patch: { status: 'todo' } }],
      ['issues:move', { org_id: 'org', id: 'm', project_id: 'home' }],
      ['comments:remove', { org_id: 'org', id: comment.args.id }],
    ])
    expect(writes.comments()).toEqual({ made: 2, posted: 1, failed: 1 })
    // a move that failed going out is tried again, and only the title goes back
    const refused = changeWrites(tasks)
    refused.next(1)
    expect(refused.next(5).args.project_id).toBe('sib')
    expect(refused.restores()).toEqual([
      ['issues:update', { org_id: 'org', id: 'r', patch: { title: 'Calibrate' } }],
    ])
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
  const task = (id, assignee_id, extra = {}) => ({
    id,
    assignee_id,
    status: 'todo',
    project_id: 'sub-a',
    ...extra,
  })

  it("gives each added person open tasks of the seed's other people where it holds Edit, never Nora's", () => {
    const tasks = [
      task('t5', 'leo'),
      task('t1', 'nora'),
      task('t2', 'aisha', { status: 'done' }),
      task('t3', 'leo', { status: 'review' }),
      task('t4', 'leo', { has_subtasks: true }),
      task('t6', 'leo', { parent_id: 't5' }),
      task('t7', null),
      task('t8', 'emil', { status: 'progress', project_id: 'sub-b' }),
      task('t9', 'emil', { status: 'backlog', project_id: 'sub-b' }),
      task('t0', 'emil', { project_id: 'sub-c' }),
    ]
    const places = new Map([
      ['p1', ['sub-a']],
      ['p2', ['sub-b', 'sub-a']],
    ])
    expect(everydayAssignments(places, tasks, 2, 'nora')).toEqual({
      pairs: [
        ['t5', 'p1'],
        ['t7', 'p1'],
        ['t8', 'p2'],
        ['t9', 'p2'],
      ],
      short: [],
    })
    // t0's sub-project is nobody's place, so nobody is given it
    const one = new Map([['p1', ['sub-b']]])
    expect(everydayAssignments(one, tasks, 3, 'nora')).toEqual({
      pairs: [
        ['t8', 'p1'],
        ['t9', 'p1'],
      ],
      short: ['p1'],
    })
  })

  it('puts each person in 3 teams and lets it hold tasks only where a team of it holds Edit', () => {
    const base = ['hardware', 'cloud']
    const added = ['t0', 't1', 't2', 't3', 't4']
    expect(teamsOfPerson(0, base, added)).toEqual(['hardware', 't0', 't3'])
    expect(teamsOfPerson(3, base, added)).toEqual(['cloud', 't3', 't1'])
    const projects = [
      { id: 'sensor', children: [{ id: 'sensor-fw' }, { id: 'sensor-hw' }] },
      { id: 'cloud-app', children: [{ id: 'cloud-api' }] },
    ]
    const places = holdPlaces(
      [
        { key: 'p1', profile_id: 'prof-1' },
        { key: 'p4', profile_id: 'prof-4' },
      ],
      {
        projects,
        // each Northstar team holds Edit on its own project alone
        editors: new Map([
          ['sensor', new Set(['hardware'])],
          ['cloud-app', new Set(['cloud'])],
        ]),
        sharedBy: new Map([
          ['t0', 'cloud-api'],
          ['t1', 'sensor-hw'],
          ['t3', 'sensor-fw'],
        ]),
        teamsOf: (person) => teamsOfPerson(Number(person.key.slice(1)) - 1, base, added),
      },
    )
    expect(places.get('prof-1')).toEqual(['sensor-fw', 'sensor-hw', 'cloud-api'])
    expect(places.get('prof-4')).toEqual(['cloud-api', 'sensor-fw', 'sensor-hw'])
  })

  it('counts what an earlier run assigned and names the people left short', () => {
    const tasks = [task('t1', 'p1'), task('t2', 'leo'), task('t3', 'leo')]
    const places = new Map([
      ['p1', ['sub-a']],
      ['p2', ['sub-a']],
      ['p3', ['sub-a']],
    ])
    // p1 holds one already, so one more; p2 gets the last; p3 none
    expect(everydayAssignments(places, tasks, 2, 'nora')).toEqual({
      pairs: [
        ['t2', 'p1'],
        ['t3', 'p2'],
      ],
      short: ['p2', 'p3'],
    })
    expect(everydayAssignments(new Map([['p1', ['sub-a']]]), tasks, 0, 'nora')).toEqual({
      pairs: [],
      short: [],
    })
  })
})

describe("setup's plan", () => {
  it('names the same rows on every run, as lowercase version 4 UUIDs', () => {
    expect(stableId('person:0')).toBe(stableId('person:0'))
    expect(stableId('person:0')).not.toBe(stableId('person:1'))
    expect(stableId('team:3')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it("finds a seat by slug or by its organization's row, with the profile's own teams", () => {
    const root = {
      seats: [
        { org: { id: 'org-ns', slug: 'northstar-labs', name: 'Northstar' } },
        { org: { id: 'org-h', slug: 'harbor', name: 'Harbor Analytics' } },
      ],
      profiles: [
        { id: 'prof-ns', org_id: 'org-ns', org_role: 'admin' },
        { id: 'prof-h', org_id: 'org-h', org_role: 'user' },
      ],
      memberships: [
        { team_id: 'team-1', profile_id: 'prof-ns' },
        { team_id: 'team-1', profile_id: 'prof-ns' },
        { team_id: 'team-2', profile_id: 'prof-h' },
      ],
    }
    expect(findSeat(root, 'northstar-labs')).toEqual({
      org_id: 'org-ns',
      slug: 'northstar-labs',
      profile_id: 'prof-ns',
      team_ids: ['team-1'],
    })
    expect(findSeat(root, (row) => row.name === 'Harbor Analytics')).toMatchObject({
      profile_id: 'prof-h',
      team_ids: ['team-2'],
    })
    expect(findSeat(root, 'elsewhere')).toBeNull()
  })

  it('addresses the views on Luma Sensor, its Board on Firmware or the whole project', () => {
    const plan = {
      org_slug: 'northstar-labs',
      projects: [
        { name: 'Atlas', num: 1, children: [] },
        {
          name: 'Luma Sensor',
          num: 4,
          children: [
            { name: 'Electronics', num: 5 },
            { name: 'Firmware', num: 6 },
          ],
        },
      ],
    }
    expect(viewUrls(plan)).toEqual({
      board: '/app/northstar-labs/board/p/6',
      overview: '/app/northstar-labs/overview/p/4',
      roadmap: '/app/northstar-labs/roadmap/p/4',
      sync: '/app/northstar-labs/sync/p/4',
      inbox: '/app/northstar-labs/inbox',
      mine: '/app/northstar-labs/board/mine',
    })
    expect(viewUrls(plan, true).board).toBe('/app/northstar-labs/board/p/4')
  })
})

describe('which client replays what', () => {
  const person = (key, org) => ({
    key,
    profile_id: `prof-${key}`,
    auth_user_id: `auth-${key}`,
    org_id: org,
  })
  const set = (view, org, queries, recorder = 'prof-nora') => ({
    view,
    person: { profile_id: recorder, auth_user_id: 'auth-nora', org_id: org },
    queries,
  })
  const northstar = [
    set('board', 'org-ns', [
      { udfPath: 'tasks:board', args: { org_id: 'org-ns', project_id: 'proj-ns' }, bytes: 900 },
      { udfPath: 'inbox:feed', args: { after: 1 }, bytes: 50 },
      { udfPath: 'notifications:settings', args: {}, bytes: 21 },
      { udfPath: 'billing:status', args: { org_id: 'org-h' }, bytes: 10 },
    ]),
    set('inbox', 'org-ns', [{ udfPath: 'inbox:page', args: { org_id: 'org-ns' }, bytes: 400 }]),
    set('mine', 'org-ns', [
      { udfPath: 'planning:ownerLoads', args: { org_id: 'org-ns', owner_ids: ['prof-nora'] } },
    ]),
  ]

  it('gives person i view i of one organization, Nora first, never My view to another, and only leaders the leader reads', () => {
    const plan = {
      people: ['nora', 'p1', 'p2', 'p3'].map((key) => person(key, 'org-ns')),
    }
    const specs = clientSpecs({ clients: 4, orgs: 1 }, plan, [northstar])
    expect(specs.map((spec) => [spec.person.key, spec.view, spec.lead, spec.watch])).toEqual([
      ['nora', 'board', true, 'nora'],
      ['p1', 'inbox', false, null],
      ['p2', 'board', true, null],
      ['p3', 'inbox', false, null],
    ])
    expect(specs.map((spec) => spec.recorder)).toEqual([true, false, false, false])
    // Nora keeps her other seat's read; a person with one seat holds none
    expect(specs[0].queries.map((query) => query.udfPath)).toContain('billing:status')
    expect(specs[2].queries.map((query) => query.udfPath)).toEqual([
      'tasks:board',
      'inbox:feed',
      'notifications:settings',
    ])
    expect(specs[2].queries[0].args.org_id).toBe('org-ns')
    expect(specs[0].recorded_answer_bytes).toBe(981)
    expect(() => clientSpecs({ clients: 5, orgs: 1 }, plan, [northstar])).toThrow(
      'fewer than its share of --clients',
    )
    // sets another profile recorded, such as those of an earlier setup
    const other = { people: [person('leo', 'org-ns'), person('p1', 'org-ns')] }
    expect(() => clientSpecs({ clients: 1, orgs: 1 }, other, [northstar])).toThrow(
      'recorded by another profile than leo',
    )
    // with My view alone, nobody but its recorder has a set to replay
    expect(() => clientSpecs({ clients: 2, orgs: 1 }, plan, [[northstar[2]]])).toThrow(
      'holds no recorded set another person can replay',
    )
  })

  /* Northstar and Harbor as setup writes them: each organization's own
     ids, and Harbor's sets recorded there by Nora's guest seat. */
  const northstarOrg = {
    k: 0,
    org_id: 'org-ns',
    org_slug: 'northstar-labs',
    profile_ids: ['prof-nora', 'prof-p1', 'prof-leo'],
    projects: [{ id: 'proj-ns', children: [{ id: 'sub-ns' }] }],
    teams: ['team-ns'],
    people: [person('nora', 'org-ns'), person('p1', 'org-ns')],
  }
  const harborOrg = {
    k: 1,
    org_id: 'org-h',
    org_slug: 'harbor',
    projects: [{ id: 'proj-h', children: [] }],
    teams: ['team-h'],
    owner: person('owner1', 'org-h'),
    people: [person('nora@harbor', 'org-h'), person('o1p1', 'org-h')],
  }
  const harbor = [
    set(
      'board',
      'org-h',
      [
        { udfPath: 'tasks:board', args: { org_id: 'org-h', project_id: 'proj-h' }, bytes: 300 },
        { udfPath: 'inbox:feed', args: { after: 1 }, bytes: 50 },
        { udfPath: 'billing:status', args: { org_id: 'org-ns' }, bytes: 10 },
      ],
      'prof-nora@harbor',
    ),
    set(
      'inbox',
      'org-h',
      [{ udfPath: 'inbox:page', args: { org_id: 'org-h' }, bytes: 200 }],
      'prof-nora@harbor',
    ),
  ]

  it("deals clients to the organizations in turn, each on its own organization's sets, with Nora's one leading tab in Northstar", () => {
    const plan = { ...northstarOrg, orgs: [northstarOrg, harborOrg] }
    const specs = clientSpecs({ clients: 4, orgs: 2 }, plan, [northstar, harbor])
    expect(specs.map((spec) => [spec.org, spec.person.key, spec.view, spec.lead])).toEqual([
      ['northstar-labs', 'nora', 'board', true],
      ['harbor', 'nora@harbor', 'board', false],
      ['northstar-labs', 'p1', 'inbox', false],
      ['harbor', 'o1p1', 'inbox', false],
    ])
    // Nora's Harbor tab does not lead, so it holds no leader read, and
    // keeps her Northstar seat's read as she recorded it
    expect(specs[1].queries.map((query) => query.udfPath)).toEqual([
      'tasks:board',
      'billing:status',
    ])
    // Harbor's people replay Harbor's own sets, which name no Northstar id
    expect(specs[3].queries).toEqual(harbor[1].queries)
    expect(checkSpecs(specs, plan.orgs)).toBe(specs)
  })

  it("refuses a client that would read another organization's ids or one id twice in a list", () => {
    const spec = (queries) => ({
      index: 3,
      org: 'harbor',
      view: 'board',
      person: person('o1p1', 'org-h'),
      recorder: false,
      queries,
    })
    // a set mirrored from Northstar that keeps a Northstar person
    const mirrored = spec([
      { udfPath: 'people:byIds', args: { org_id: 'org-h', ids: ['prof-o1p1', 'prof-leo'] } },
    ])
    expect(() => checkSpecs([mirrored], [northstarOrg, harborOrg])).toThrow(
      'client 3 (o1p1, board) would read people:byIds with prof-leo, an id of northstar-labs',
    )
    const nested = spec([
      { udfPath: 'tasks:board', args: { scope: { org_id: 'org-h', project_id: 'sub-ns' } } },
    ])
    expect(() => checkSpecs([nested], [northstarOrg, harborOrg])).toThrow('an id of northstar-labs')
    const doubled = spec([
      {
        udfPath: 'planning:ownerLoads',
        args: { org_id: 'org-h', owner_ids: ['prof-o1p1', 'prof-x', 'prof-o1p1'] },
      },
    ])
    expect(() => checkSpecs([doubled], [northstarOrg, harborOrg])).toThrow(
      'with prof-o1p1 twice in one list',
    )
    // the recorder replays her own tabs as recorded, her other seats' reads included
    expect(() =>
      checkSpecs([{ ...mirrored, recorder: true }], [northstarOrg, harborOrg]),
    ).not.toThrow()
  })
})

describe("a phase's figures", () => {
  const report = (pid, extra = {}) => ({
    pid,
    clients: 1,
    calls: { 'issues:update': { calls: 2, failed: 1, ms: [10, 30] } },
    per_client_bytes: [{ index: pid, bytes: 100 * pid }],
    closes: { 1013: 1 },
    answers: { 'tasks:board': { updates: 2, bytes: 200 } },
    dropped: 1,
    watched: [],
    in_flight_most: 3,
    event_loop_lag_ms: { p50: 0, p99: 1, max: 2 },
    changes: [],
    ...extra,
  })
  const entry = (fn, start, js_ms, extra = {}) => ({
    fn,
    component: null,
    kind: 'Mutation',
    nested: false,
    cached: false,
    start,
    end: start + js_ms,
    js_ms,
    total_ms: js_ms,
    error: null,
    ...extra,
  })

  it('sums the workers and says where the log missed calls the clients made', () => {
    const figures = phaseFigures(
      [entry('issues:update', 0, 20), entry('issues:update', 5, 600)],
      2,
      [report(1), report(2)],
      { steal: null },
    )
    expect(figures).toMatchObject({
      clients: 2,
      seconds: 2,
      closes: { 1013: 2 },
      dropped_by_benchmark: 2,
      in_flight_most: 6,
      bytes_total: 300,
      backend_at_once: 2,
      answers: { 'tasks:board': { updates: 4, bytes: 400 } },
      over_line: [{ fn: 'issues:update', js_ms_max: 600 }],
      log_coverage: {
        state: 'lower_bounds',
        compared: 1,
        missed: [{ fn: 'issues:update', calls: 4, logged: 2 }],
        read_failures: 0,
      },
      steal: null,
    })
    expect(figures.client_calls['issues:update']).toMatchObject({ calls: 4, failed: 2, logged: 2 })
  })

  it("compares the clients' and the writer's calls with the log, and says unknown when nothing was sent", () => {
    const stats = functionStats(
      [entry('issues:update', 0, 20), entry('notifications:beat', 1, 5)],
      2,
    )
    const beat = { 'notifications:beat': { calls: 1, failed: 0, ms: [5] } }
    expect(logCoverage(stats, beat, { writerCalls: { 'issues:update': 1 } })).toEqual({
      state: 'complete',
      compared: 2,
      missed: [],
      read_failures: 0,
    })
    // the writer's second rename is missing from the log
    expect(logCoverage(stats, beat, { writerCalls: { 'issues:update': 2 } })).toMatchObject({
      state: 'lower_bounds',
      missed: [{ fn: 'issues:update', calls: 2, logged: 1 }],
    })
    // a failed read of the log may have lost entries
    expect(logCoverage(stats, beat, { readFailures: 1 }).state).toBe('lower_bounds')
    // clients that lead no alerts and no writer: nothing to compare, not complete
    expect(logCoverage(functionStats([], 60), {})).toEqual({
      state: 'unknown',
      compared: 0,
      missed: [],
      read_failures: 0,
    })
  })

  it('merges counts and calls by name', () => {
    expect(
      mergeCounts([
        { a: { updates: 1, bytes: 2 } },
        { a: { updates: 3, bytes: 4 }, b: { updates: 1, bytes: 1 } },
      ]),
    ).toEqual({
      a: { updates: 4, bytes: 6 },
      b: { updates: 1, bytes: 1 },
    })
    expect(
      mergeCalls([
        { x: { calls: 1, failed: 0, ms: [5] } },
        { x: { calls: 2, failed: 1, ms: [7, 9] } },
      ]),
    ).toEqual({
      x: { calls: 3, failed: 1, ms: [5, 7, 9] },
    })
  })

  it('gives every change what it re-sent to each client, none counting as 0', () => {
    const figures = {
      changes: [
        { id: 0, kind: 'rename' },
        { id: 1, kind: 'comment' },
      ],
      _changes: [
        { id: 0, per_client: { 0: 500 }, queries: { 'tasks:board': { updates: 1, bytes: 500 } } },
        { id: 0, per_client: { 1: 300 }, queries: { 'tasks:board': { updates: 1, bytes: 300 } } },
      ],
    }
    attachResends(figures, 3)
    expect(figures.changes[0]).toMatchObject({
      clients_resent: 2,
      resent_bytes_per_client: { count: 3, p50: 300, max: 500 },
      updated: { 'tasks:board': { updates: 2, bytes: 800 } },
    })
    expect(figures.changes[1]).toMatchObject({
      clients_resent: 0,
      resent_bytes_per_client: { max: 0 },
    })
    expect(Object.keys(figures.bytes_per_client_per_change)).toEqual(['rename', 'comment'])
    // the rename's two answers are the most one change re-sent
    expect(figures.changes.map((change) => change.answers)).toEqual([2, 0])
    expect(figures.asked_at_once).toBe(2)
    expect(figures.failed_by_kind).toEqual({})
  })

  it("leaves a refused change out of its kind's re-sends and counts it apart", () => {
    const figures = {
      changes: [
        { id: 0, kind: 'move', error: null },
        { id: 1, kind: 'move', error: 'This person cannot hold tasks in this project.' },
      ],
      _changes: [{ id: 0, per_client: { 0: 700, 1: 700 }, queries: {} }],
    }
    attachResends(figures, 2)
    // the refused move's zero bytes would have halved the spread's p50
    expect(figures.bytes_per_client_per_change.move).toEqual({
      count: 2,
      p50: 700,
      p99: 700,
      max: 700,
    })
    expect(figures.failed_by_kind).toEqual({ move: 1 })
  })

  it('fires the pacing trigger on the modelled hosted load, a call over the line or a slow reconnect, never on a local overload', () => {
    const whole = { log_coverage: { state: 'complete' } }
    const quiet = {
      startup: { ...whole, closes: {}, over_line: [], asked_at_once: 140 },
      reconnect: { ...whole, closes: {}, slow_clients: 0, asked_at_once: 139 },
    }
    expect(pacingTrigger(quiet)).toMatchObject({ fires: false, fires_outside_noisy_phases: false })
    const noisy = {
      ...quiet,
      startup: {
        ...whole,
        closes: {},
        noisy: true,
        over_line: [{ fn: 'tasks:board', js_ms_max: 700 }],
      },
    }
    expect(pacingTrigger(noisy)).toMatchObject({ fires: true, fires_outside_noisy_phases: false })
    // a saturated local backend's closes are the test bed's, and fire nothing
    expect(pacingTrigger({ ...quiet, idle: { ...whole, closes: { 1013: 4 } } })).toMatchObject({
      test_bed_saturated: [{ phase: 'idle', overload_closes: 4 }],
      fires: false,
      fires_outside_noisy_phases: false,
    })
    expect(pacingTrigger({ ...quiet, reconnect: { closes: {}, slow_clients: 2 } }).fires).toBe(true)
    // more than hosted Professional's 256 queries asked at once fires, 256 does not
    const crowded = { ...quiet, reconnect: { ...quiet.reconnect, asked_at_once: 257 } }
    expect(pacingTrigger(crowded)).toMatchObject({
      past_hosted_slots: [{ phase: 'reconnect', asked_at_once: 257 }],
      fires: true,
      fires_outside_noisy_phases: true,
    })
    expect(
      pacingTrigger({ ...quiet, startup: { ...quiet.startup, asked_at_once: 256 } }).fires,
    ).toBe(false)
    // a log that may have missed calls cannot show that none passed the line
    const lossy = { ...quiet, idle: { log_coverage: { state: 'lower_bounds' }, closes: {} } }
    expect(pacingTrigger(lossy)).toMatchObject({
      log_incomplete: ['idle'],
      fires: null,
      fires_outside_noisy_phases: null,
    })
    expect(pacingTrigger({ ...lossy, reconnect: { ...whole, slow_clients: 1 } }).fires).toBe(true)
    // no functions at all, as from an empty log, is unknown, not quiet
    expect(pacingTrigger({ idle: { log_coverage: { state: 'unknown' } } }).fires).toBeNull()
  })

  it('answers the pacing trigger unknown where a check was not measured or its noise is unknown', () => {
    const whole = { log_coverage: { state: 'complete' }, closes: {}, noisy: false }
    const reconnect = { ...whole, slow_clients: 0 }
    expect(pacingTrigger({ reconnect })).toMatchObject({
      unmeasured: [],
      fires: false,
      fires_outside_noisy_phases: false,
    })
    // a reconnect with no lone client's time, as without the match phase, measured nothing
    expect(pacingTrigger({ reconnect: { ...reconnect, slow_clients: null } })).toMatchObject({
      unmeasured: ['reconnect'],
      fires: null,
      fires_outside_noisy_phases: null,
    })
    // a phase that failed or lost a worker, whatever its surviving log covers
    const failed = { reconnect, busy: { ...whole, failed: 'a busy loop exited (1)' } }
    expect(pacingTrigger(failed)).toMatchObject({ unmeasured: ['busy'], fires: null })
    const lost = { reconnect, changes: { ...whole, failed: 'worker exited', workers_lost: [7] } }
    expect(pacingTrigger(lost).fires_outside_noisy_phases).toBeNull()
    // a call over the line in a phase whose noise is unknown is no clean timing
    const slowCall = { ...whole, over_line: [{ fn: 'tasks:board', js_ms_max: 700 }] }
    expect(pacingTrigger({ reconnect, startup: { ...slowCall, noisy: null } })).toMatchObject({
      fires: true,
      fires_outside_noisy_phases: null,
    })
    expect(pacingTrigger({ reconnect, startup: slowCall }).fires_outside_noisy_phases).toBe(true)
    // a slow reconnect counts outside the noisy phases only when its own phase was quiet
    const slowly = (noisy) => pacingTrigger({ reconnect: { ...reconnect, slow_clients: 1, noisy } })
    expect(slowly(true)).toMatchObject({ fires: true, fires_outside_noisy_phases: false })
    expect(slowly(null)).toMatchObject({ fires: true, fires_outside_noisy_phases: null })
    expect(slowly(false).fires_outside_noisy_phases).toBe(true)
  })

  it('models the queries a phase ran at once on average from its executed queries', () => {
    const changes = {
      seconds: 10,
      asked_at_once: 12,
      functions: {
        'tasks:board': { kind: 'Query', total_ms_sum: 4000 },
        'issues:update': { kind: 'Mutation', total_ms_sum: 9000 },
      },
    }
    expect(hostedModel({ changes, idle: { seconds: 60, functions: {} } })).toEqual({
      phases: {
        changes: { asked_at_once: 12, running_on_average: 0.4 },
        idle: { asked_at_once: null, running_on_average: 0 },
      },
      past_slots: [],
    })
  })

  it("reads the watched clients' and the tabs' idle answers per minute", () => {
    expect(
      watchedPerMinute(
        [
          { client: 'nora', udfPath: 'inbox:feed', updates: 2, bytes: 100 },
          { client: 'nora', udfPath: 'tasks:board', updates: 0, bytes: 0 },
        ],
        120,
      ),
    ).toEqual({
      nora: { 'inbox:feed': { answers: 1, bytes: 50 }, 'tasks:board': { answers: 0, bytes: 0 } },
    })
    const idle = {
      seconds: 30,
      per_tab: [
        {
          index: 0,
          view: 'board',
          bytes: 200,
          frames: 4,
          answers: { 'inbox:feed': { updates: 1, bytes: 50 } },
        },
      ],
      functions: { 'notifications:beat': { executions: 1, js_ms_sum: 4 } },
    }
    expect(tabsIdlePerMinute(idle)).toEqual({
      per_tab_minute: [
        {
          index: 0,
          view: 'board',
          bytes: 400,
          frames: 8,
          answers: 2,
          answers_by_function: { 'inbox:feed': { updates: 2, bytes: 100 } },
        },
      ],
      backend_per_minute: {
        executions: 2,
        js_ms: 8,
        functions: { 'notifications:beat': { executions: 2, js_ms: 8 } },
      },
    })
  })

  it('gives each tab what each change re-sent to it, by tab and by view', () => {
    const changes = [
      { id: 0, kind: 'rename' },
      { id: 1, kind: 'rename' },
    ]
    const tabs = [
      { index: 0, view: 'board', perChange: new Map([[0, { bytes: 900, queries: {} }]]) },
      { index: 1, view: 'board', perChange: new Map([[1, { bytes: 100, queries: {} }]]) },
    ]
    const resent = tabResends(changes, tabs)
    expect(changes[0].resent_per_tab.map((tab) => tab.bytes)).toEqual([900, 0])
    expect(resent.bytes_per_tab_per_change.rename[0]).toMatchObject({ count: 2, max: 900 })
    expect(resent.bytes_per_view_per_change.rename.board).toMatchObject({ count: 4, max: 900 })
  })
})

describe("the busy phase's loops", () => {
  /** Whether process `pid` still runs; a zombie, which a sandbox's init
      may never reap, does not. */
  const runs = (pid) => {
    try {
      process.kill(pid, 0)
    } catch {
      return false
    }
    try {
      return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
    } catch {
      return true
    }
  }

  it('fails where its loops cannot start on the CPUs given, and stops quietly when asked', async () => {
    const refused = busyLoops(2, '4095')
    try {
      await vi.waitFor(() => expect(() => refused.check()).toThrow(/busy loop/), { timeout: 3000 })
    } finally {
      refused.stop()
    }
    const spinning = busyLoops(1, null)
    try {
      await new Promise((done) => setTimeout(done, 300))
      expect(() => spinning.check()).not.toThrow()
      expect(runs(spinning.pids[0])).toBe(true)
    } finally {
      spinning.stop()
    }
    await vi.waitFor(() => expect(runs(spinning.pids[0])).toBe(false), { timeout: 3000 })
    expect(() => spinning.check()).not.toThrow()
  })

  it('leaves no loop spinning when its coordinator is killed by a signal', async () => {
    const busy = new URL('./load/busy.mjs', import.meta.url).href
    const coordinator = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { busyLoops } from ${JSON.stringify(busy)}; console.log(busyLoops(1, null).pids[0]); setInterval(() => {}, 1000)`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    const pid = Number(
      await new Promise((done) => coordinator.stdout.once('data', (chunk) => done(String(chunk)))),
    )
    try {
      expect(runs(pid)).toBe(true)
      coordinator.kill('SIGTERM')
      await vi.waitFor(() => expect(runs(pid)).toBe(false), { timeout: 3000 })
    } finally {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
      coordinator.kill('SIGKILL')
    }
  })
})
