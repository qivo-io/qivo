// The Convex sync protocol as the combined load benchmark reads it
// (scripts/benchmark-load.mjs): one client's WebSocket frames, the query
// set they name, each query's last answer and its bytes, and whether the
// client is current. The record part feeds it a real tab's frames from
// Playwright and the replay part a Node client's frames from its socket,
// so both measure the same way. Also the recorded set's format, what
// another person replays of it and the comparison of a replay with a tab.
//
// A frame is the JSON text Convex sends (convex/browser's protocol): the
// client's Connect, ModifyQuerySet, Mutation, Action and Authenticate, and
// the server's Transition, TransitionChunk, MutationResponse,
// ActionResponse, AuthError, FatalError and Ping. An answer's bytes are the
// UTF-8 length of its value's JSON as the frame carries it. Authenticate
// frames are read for nothing, so no token reaches a recorded set.

/** The recorded set's format name, which a reader checks. */
export const SET_FORMAT = 'qivo-load-set/1'

const encoder = new TextEncoder()

/** The UTF-8 bytes of string `text`. */
export const bytesOf = (text) => encoder.encode(text).length

/** The protocol's integer versions and ids, which Convex's JSON encodes as
    plain numbers or, for request ids, as numbers too. */
const num = (value) => (typeof value === 'number' ? value : Number(value))

/** One client's view of its own frames. `now` gives the time in
    milliseconds, and `onAnswer(udfPath, bytes, query)` hears each answer
    as it arrives. */
export class FrameTracker {
  constructor({ now = () => Date.now(), onAnswer = () => {} } = {}) {
    this.now = now
    this.onAnswer = onAnswer
    /** queryId -> { udfPath, args, componentPath, answered, bytes, error, updates, addedAt, answeredAt } */
    this.queries = new Map()
    this.sentVersion = 0
    this.ackVersion = 0
    this.connects = 0
    this.closes = []
    /** requestId -> { udfPath, at } for mutations and actions awaiting their response */
    this.pending = new Map()
    /** udfPath -> { calls, ms: [] } for the mutations and actions answered */
    this.calls = new Map()
    this.framesSent = 0
    this.framesReceived = 0
    this.bytesReceived = 0
    this.lastFrameAt = null
    /** When the newest set became current, null while it is not: the
        moment both parts time to current from, so a tab's time and a
        replayed client's measure the same moment. */
    this.currentSince = null
    this.chunks = null
  }

  /** Keeps `currentSince` with the set's state after a change at `at`. */
  noteCurrent(at) {
    if (!this.current) this.currentSince = null
    else this.currentSince ??= at
  }

  /** A frame the client sent, as text. */
  sent(text) {
    this.framesSent++
    const message = JSON.parse(text)
    if (message.type === 'Connect') this.connects++
    else if (message.type === 'ModifyQuerySet') this.modify(message)
    else if (message.type === 'Mutation' || message.type === 'Action')
      this.pending.set(num(message.requestId), { udfPath: message.udfPath, at: this.now() })
  }

  /** The query set change `message`. A base version of 0 starts the set
      again, as a client does after it reconnects. */
  modify(message) {
    if (num(message.baseVersion) === 0) {
      this.queries.clear()
      this.ackVersion = 0
    }
    const at = this.now()
    for (const change of message.modifications) {
      if (change.type === 'Add')
        this.queries.set(num(change.queryId), {
          udfPath: change.udfPath,
          args: change.args?.[0] ?? {},
          ...(change.componentPath ? { componentPath: change.componentPath } : {}),
          answered: false,
          bytes: null,
          error: null,
          updates: 0,
          addedAt: at,
          answeredAt: null,
        })
      else if (change.type === 'Remove') this.queries.delete(num(change.queryId))
    }
    this.sentVersion = num(message.newVersion)
    this.noteCurrent(at)
  }

  /** A frame the server sent, as text. */
  received(text) {
    const at = this.now()
    this.framesReceived++
    this.bytesReceived += bytesOf(text)
    const message = JSON.parse(text)
    if (message.type === 'Ping') return
    this.lastFrameAt = at
    if (message.type === 'TransitionChunk') {
      // a large transition arrives in parts, joined in order
      if (num(message.partNumber) === 0) this.chunks = []
      this.chunks?.push(message.chunk)
      if (this.chunks && this.chunks.length === num(message.totalParts)) {
        const joined = this.chunks.join('')
        this.chunks = null
        this.transition(JSON.parse(joined), at)
      }
      return
    }
    if (message.type === 'Transition') this.transition(message, at)
    else if (message.type === 'MutationResponse' || message.type === 'ActionResponse') {
      const id = num(message.requestId)
      const call = this.pending.get(id)
      if (!call) return
      this.pending.delete(id)
      const done = this.calls.get(call.udfPath) ?? { calls: 0, failed: 0, ms: [] }
      done.calls++
      if (message.success === false) done.failed++
      done.ms.push(at - call.at)
      this.calls.set(call.udfPath, done)
    }
  }

  /** Transition `message`, received at `at`. */
  transition(message, at) {
    for (const change of message.modifications) {
      const query = this.queries.get(num(change.queryId))
      if (!query) continue
      if (change.type === 'QueryUpdated') {
        query.bytes = bytesOf(JSON.stringify(change.value ?? null))
        query.error = null
      } else if (change.type === 'QueryFailed') {
        query.bytes = 0
        query.error = String(change.errorMessage ?? 'failed').slice(0, 200)
      } else continue
      query.answered = true
      query.answeredAt ??= at
      query.updates++
      this.onAnswer(query.udfPath, query.bytes, query)
    }
    this.ackVersion = num(message.endVersion?.querySet ?? this.ackVersion)
    this.noteCurrent(at)
  }

  /** The socket closed with `code` and `reason`, by the client itself when
      `byClient` (the benchmark's own drop), else by the server or the
      network. */
  closed(code, reason = '', byClient = false) {
    this.closes.push({
      code,
      reason: String(reason).slice(0, 120),
      at: this.now(),
      by_client: byClient,
    })
  }

  /** Whether the server answered every query of the set the client sent
      last, at that set's version. A client with no query is not current. */
  get current() {
    if (this.queries.size === 0 || this.ackVersion !== this.sentVersion) return false
    for (const query of this.queries.values()) if (!query.answered) return false
    return true
  }

  /** Whether the current set holds an answered query of function
      `udfPath`. */
  holds(udfPath) {
    for (const query of this.queries.values())
      if (query.udfPath === udfPath && query.answered) return true
    return false
  }

  /** The queries waiting for their first answer since they were added. */
  get waiting() {
    let count = 0
    for (const query of this.queries.values()) if (!query.answered) count++
    return count
  }

  /** Each answered query of the current set as [udfPath, milliseconds from
      its Add to its first answer], the client's own timing of a query,
      which a saturated function log cannot drop. */
  firstAnswers() {
    return [...this.queries.values()]
      .filter((query) => query.answeredAt !== null)
      .map((query) => [query.udfPath, query.answeredAt - query.addedAt])
  }

  /** The query set as a recorded set's `queries`, in a stable order: each
      query's function, arguments, component when it has one, its last
      answer's bytes and its error when it failed. */
  set() {
    return sortQueries(
      [...this.queries.values()].map((query) => ({
        udfPath: query.udfPath,
        args: query.args,
        ...(query.componentPath ? { componentPath: query.componentPath } : {}),
        bytes: query.bytes,
        ...(query.error ? { error: query.error } : {}),
      })),
    )
  }
}

/** JSON text of `value` with object keys sorted, so two equal values give
    equal text whatever order their keys came in. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/** `queries` sorted by function, then by arguments. */
export function sortQueries(queries) {
  const key = (query) => `${query.udfPath}\u0000${canonical(query.args)}`
  return [...queries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
}

/** A recorded set: the tab's `view`, its address `url`, the `browser`, the
    `person` whose ids the set names ({ profile_id, auth_user_id, org_id }),
    the tracker's queries and the mutations and actions the tab called
    while it was recorded, by name and count, and its frame totals. */
export function recordedSet({ view, url, browser, person, tracker, recordedAt }) {
  return {
    format: SET_FORMAT,
    view,
    url,
    browser,
    recorded_at: recordedAt,
    person,
    current: tracker.current,
    queries: tracker.set(),
    calls: Object.fromEntries(
      [...tracker.calls.entries()].sort().map(([name, done]) => [name, done.calls]),
    ),
    frames: {
      sent: tracker.framesSent,
      received: tracker.framesReceived,
      bytes_received: tracker.bytesReceived,
    },
  }
}

/** Recorded set `value`, checked: its format, a person with a profile, a
    login and an organization, and queries that each name a function and
    hold an arguments object. Throws an Error that names what is wrong. */
export function checkSet(value) {
  if (value?.format !== SET_FORMAT) throw new Error(`not a recorded set (${SET_FORMAT})`)
  const person = value.person ?? {}
  for (const field of ['profile_id', 'auth_user_id', 'org_id'])
    if (typeof person[field] !== 'string' || person[field] === '')
      throw new Error(`the recorded set of ${value.view} names no person ${field}`)
  if (!Array.isArray(value.queries) || value.queries.length === 0)
    throw new Error(`the recorded set of ${value.view} holds no query`)
  for (const query of value.queries)
    if (typeof query.udfPath !== 'string' || query.args === null || typeof query.args !== 'object')
      throw new Error(
        `the recorded set of ${value.view} holds a query without a function or arguments`,
      )
  return value
}

/** The organization arguments `args` name: the first `org_id` string at
    any depth, a query's own before its scope's (tasks:board and the
    Overview's reads carry it in `scope`), or null for none. */
export function orgArgOf(args) {
  const queue = [args]
  while (queue.length > 0) {
    const value = queue.shift()
    if (value === null || typeof value !== 'object') continue
    if (!Array.isArray(value) && typeof value.org_id === 'string') return value.org_id
    queue.push(...Object.values(value))
  }
  return null
}

/** Every string of `value` at any depth, object keys left out. */
export function stringsOf(value) {
  if (typeof value === 'string') return [value]
  if (value === null || typeof value !== 'object') return []
  return Object.values(value).flatMap(stringsOf)
}

/** The views whose reads follow the recorder's own rows rather than what
    the view shows to whoever opens it: My view's tasks are the recorder's,
    so its people, projects and owner loads are the recorder's too, and
    another person's My view reads other ids, which only that person's own
    tab can record. */
export const PERSONAL_VIEWS = ['mine']

/**
 * Recorded set `set`'s queries as `person`, another person of the
 * recorder's organization, subscribes them on the same view. No id is
 * swapped: the id lists a view reads (people, owners, projects) name the
 * rows the view shows, which are the same for whoever sees them, the
 * recorder among them where the rows name her, and the arguments that
 * name no row (the scope, the filters, the organization) are the same for
 * every person of the organization. A person's own tab would leave itself
 * out of its people read, which the recorded list may name, and name the
 * recorder there where the view shows her, so the replay holds the same
 * reads with at most those ids apart. With `ownOrg`, a query whose
 * `org_id`, at any depth (orgArgOf), names an organization other than the
 * recorded one is left out,
 * since it is the recording login's seat elsewhere, which a person with
 * one seat does not hold. Throws for a person of another organization,
 * whose rows the set does not show, and for a view of PERSONAL_VIEWS
 * recorded by someone else.
 */
export function personQueries(set, person, { ownOrg = false } = {}) {
  if (person.org_id !== undefined && person.org_id !== set.person.org_id)
    throw new Error(
      `the ${set.view} set was recorded in organization ${set.person.org_id}, not in ${person.org_id}, the organization of ${person.key ?? person.profile_id}`,
    )
  if (PERSONAL_VIEWS.includes(set.view) && person.profile_id !== set.person.profile_id)
    throw new Error(
      `the ${set.view} set reads its recorder's own tasks, so only its recorder replays it`,
    )
  return ownOrg
    ? set.queries.filter((query) => {
        const org = orgArgOf(query.args)
        return org === null || org === set.person.org_id
      })
    : set.queries
}

/** The reads only a tab that leads its profile's desktop alerts holds
    (src/lib/notificationLeader.ts): the Inbox feed and the delivery mode. */
export const LEADER_READS = ['inbox:feed', 'notifications:settings']

/** The calls only a leading tab makes: its beat, its claims and its
    summaries (src/lib/notificationFeed.ts). */
export const LEADER_CALLS = [
  'notifications:beat',
  'notifications:claimAlerts',
  'notifications:claimSummary',
]

/** `queries` without the leader's reads, as a tab that does not lead holds
    them. */
export const withoutLeaderReads = (queries) =>
  queries.filter((query) => !LEADER_READS.includes(query.udfPath))

/** The arguments a client derives from its clock rather than from what it
    shows, by function: the Inbox feed's floor, ten minutes before the
    leader's last beat (src/lib/notificationFeed.ts). A comparison checks
    only that such an argument is there. */
export const CLOCK_ARGS = { 'inbox:feed': ['after'] }

/** `args` of function `udfPath` with its clock-derived arguments replaced
    by a mark, so two sets compare equal whatever time each was made. */
export function maskClock(udfPath, args) {
  const fields = CLOCK_ARGS[udfPath]
  if (!fields) return args
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, fields.includes(key) ? '<clock>' : value]),
  )
}

/** The local calendar day of `date` (a Date, an ISO text or milliseconds)
    as YYYY-MM-DD, the day a tab works its dated arguments out from. */
export function localDay(date) {
  const day = new Date(date)
  const two = (value) => String(value).padStart(2, '0')
  return `${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}`
}

/** Refuses recorded sets `sets` recorded on another local day than
    `now`'s. A tab works out some arguments from its day, the daily image's
    date, the Overview's and Team sync's day and weeks and the milestones'
    and the Roadmap's ranges among them, so a set of another day would
    subscribe reads no tab makes today while the match and startup still
    compare equal, its arguments being the ones compared. Checked once,
    before a replay starts. Throws an Error that names the sets. */
export function checkSetsDay(sets, now = new Date()) {
  const today = localDay(now)
  const stale = sets.filter((set) => localDay(set.recorded_at) !== today)
  if (stale.length > 0)
    throw new Error(
      `the recorded sets ${stale.map((set) => `${set.org_slug ?? ''}${set.org_slug ? '/' : ''}${set.view} (${localDay(set.recorded_at)})`).join(', ')} were recorded on another day than today, ${today}, so their dated arguments are that day's; run the record part again`,
    )
  return sets
}

/** How a replayed set `replayed` matches recorded set `recorded`'s
    queries, both lists of { udfPath, args, bytes, error? } with the same
    person's ids: each query by function and arguments (CLOCK_ARGS masked)
    with both answers' bytes, the queries only one side holds, and
    `matched`, true when both hold the same queries and every answer has
    the same bytes and the same failure. */
export function compareSets(recorded, replayed) {
  const key = (query) => `${query.udfPath}\u0000${canonical(maskClock(query.udfPath, query.args))}`
  const theirs = new Map(replayed.map((query) => [key(query), query]))
  const rows = []
  const missing = []
  for (const query of recorded) {
    const other = theirs.get(key(query))
    theirs.delete(key(query))
    if (!other) {
      missing.push(query.udfPath)
      continue
    }
    rows.push({
      udfPath: query.udfPath,
      recorded_bytes: query.bytes,
      replayed_bytes: other.bytes,
      same_bytes: query.bytes === other.bytes,
      same_error: (query.error ?? null) === (other.error ?? null),
    })
  }
  const extra = [...theirs.values()].map((query) => query.udfPath)
  return {
    matched:
      missing.length === 0 &&
      extra.length === 0 &&
      rows.every((row) => row.same_bytes && row.same_error),
    rows,
    missing,
    extra,
  }
}

/** The bucket of subscriptionsByOrganization for a query that names no
    organization and no id of one, such as the root part or the Inbox
    summary, which read across the login's seats. */
export const NO_ORG = 'no_org_argument'

/** The organizations recorded sets `sets` read, each with the functions
    its queries name and how many queries each holds, as one login's
    subscriptions per organization. A query names its organization by its
    `org_id` at any depth (orgArgOf), else by the first of its strings that
    `idOrgs` (a Map from a project's, a person's or a team's id to its
    organization) knows, as projectNav:byIds names projects and people:byIds
    people, else it goes under NO_ORG. */
export function subscriptionsByOrganization(sets, idOrgs = new Map()) {
  const byOrg = new Map()
  for (const set of sets)
    for (const query of set.queries) {
      const named = stringsOf(query.args).find((text) => idOrgs.has(text))
      const org = orgArgOf(query.args) ?? (named === undefined ? NO_ORG : idOrgs.get(named))
      const views = byOrg.get(org) ?? new Map()
      const entry = views.get(query.udfPath) ?? { queries: 0, views: new Set() }
      entry.queries++
      entry.views.add(set.view)
      views.set(query.udfPath, entry)
      byOrg.set(org, views)
    }
  return Object.fromEntries(
    [...byOrg.entries()]
      .sort()
      .map(([org, functions]) => [
        org,
        Object.fromEntries(
          [...functions.entries()]
            .sort()
            .map(([name, entry]) => [
              name,
              { queries: entry.queries, views: [...entry.views].sort() },
            ]),
        ),
      ]),
  )
}
