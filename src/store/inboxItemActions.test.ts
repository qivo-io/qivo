import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'
import type { Row } from './rows'

/* The store's Inbox row actions (store/planner.ts P.readItem, P.unreadItem,
   P.removeItem, P.snoozeItem), which name a row's item by its organization
   and task, read and remove with the row's cutoff, paint nothing, since
   the store holds no message, and mark the row (P.inboxMarks) from the
   moment the write goes out. A refusal ends its
   mark at once, an acceptance keeps it until an Inbox ends it
   (P.endInboxMarks), and each write settles only its own. The pause
   refuses a write first, with no mark. Mark as unread and a snooze of the
   watched task hold off its read on open, by organization and task, and a
   row's accepted Mark as read frees the hold of every unread choice that
   went out before it, while a newer one holds until the server refuses
   it. Mark all as read and Remove all read mark the rows the Inbox showed
   at the press, by seat, end the marks of a run a fault stops, and a long
   one runs on the lanes every large action shares. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('./guard/liveDouble.setup')).liveOver(network),
}))
/* A run of a bulk action's lanes that rejects as a fault once the case
   that sets `fault` lets it, else the real one (lib/batchRunner.ts). */
const lanes = vi.hoisted(() => ({ fault: null as Promise<void> | null }))
vi.mock('../lib/batchRunner', async (original) => {
  const real = await original<typeof import('../lib/batchRunner')>()
  return {
    ...real,
    runLanes: async (...args: Parameters<typeof real.runLanes>) => {
      if (!lanes.fault) return real.runLanes(...args)
      await lanes.fault
      throw new Error('a fault in a lane')
    },
  }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

const at = (minute: number) =>
  new Date(Date.parse('2026-09-14T08:00:00.000Z') + minute * 60_000).toISOString()
const OTHER = 'org-other'

let store: typeof import('./planner')
let snapshot: Snapshot
let deliver: (snap: Snapshot | null) => void
let sent: {
  name: string
  args: Record<string, unknown>
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}[]
let showToast: ReturnType<typeof vi.fn>
/* What messages.bulkReach answers each seat. */
let reach: 'one' | 'many'

const P = () => store.P
const org = () => snapshot.orgs[0].id
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}
const markOf = (task: string, orgId = org()) => P().inboxMarks.get(`${orgId}:${task}`)
const answer = (n: number) => sent[n].resolve(null)
const refuse = (n: number) =>
  sent[n].reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))

function message(id: string, task: string, minute: number, over: Partial<Row<'messages'>> = {}) {
  snapshot.messages.push({
    id,
    org_id: org(),
    recipient_id: snapshot.profiles[0].id,
    issue_id: task,
    issue_title: 'Calibrate the sensor',
    kind: 'comment',
    detail: 'New comment',
    created_at: at(minute),
    ...over,
  })
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  showToast = vi.fn()
  vi.stubGlobal('window', { showToast, setTimeout, clearTimeout })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  snapshot = plannerFixture()
  for (const [n, id] of ['task-a', 'task-b'].entries())
    snapshot.issues.push({
      id,
      org_id: org(),
      project_id: snapshot.projects[0].id,
      num: 27 + n,
      title: `Task ${n}`,
      description: '',
      status: 'progress',
      priority: 'medium',
      paused: false,
      created_at: at(0),
      updated_at: at(0),
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
  message('a-1', 'task-a', 1)
  message('a-5', 'task-a', 5)
  message('b-1', 'task-b', 1, { read_at: at(2) })
  sent = []
  reach = 'one'
  lanes.fault = null
  network.query.mockImplementation(async (ref) =>
    getFunctionName(ref) === 'messages:bulkReach'
      ? { seats: snapshot.orgs.map((o) => ({ org_id: o.id, reach, before: 1 })) }
      : null,
  )
  network.onUpdate.mockImplementation((ref, _args, next) => {
    if (getFunctionName(ref) === 'workspace:whole') {
      deliver = (snap) => next(structuredClone(snap))
      deliver(snapshot)
    }
    return () => {}
  })
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'identity:claimMySeats') return Promise.resolve(null)
    return new Promise((resolve, reject) => sent.push({ name, args, resolve, reject }))
  })
  store = await import('./planner')
  await store.initStore()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('an Inbox row action', () => {
  it("sends the row's organization, task and cutoff, and marks its row", async () => {
    const through = Date.parse(at(5))
    expect(P().unreadItem({ org: org(), task: 'task-b', through })).toBe(true)
    expect(markOf('task-b')).toMatchObject({ through, read: false })
    expect(P().removeItem({ org: org(), task: 'task-a', through, latestAt: at(1) })).toBe(true)
    expect(markOf('task-a')).toMatchObject({ through, removed: true })
    expect(P().snoozeItem({ org: org(), task: 'task-b', through }, at(600))).toBe(true)
    expect(markOf('task-b')).toMatchObject({ through, snoozedUntil: at(600) })
    expect(P().snoozeItem({ org: org(), task: 'task-b', through }, null)).toBe(true)
    expect(markOf('task-b')).toMatchObject({ through, snoozedUntil: null })
    expect(sent.map(({ name, args }) => ({ name, args }))).toEqual([
      { name: 'messages:unreadItem', args: { org_id: org(), issue_id: 'task-b' } },
      { name: 'messages:removeItem', args: { org_id: org(), issue_id: 'task-a', through } },
      { name: 'messages:snoozeItem', args: { org_id: org(), issue_id: 'task-b', until: at(600) } },
      { name: 'messages:snoozeItem', args: { org_id: org(), issue_id: 'task-b', until: null } },
    ])
    // no message ids from the row
    expect(sent.some(({ args }) => 'ids' in args)).toBe(false)
  })

  it('marks its row from the moment it goes out, keeps an accepted mark until an Inbox ends it, and ends a refused one', async () => {
    const through = Date.parse(at(5))
    P().readItem({ org: org(), task: 'task-a', through, latestAt: at(5) })
    expect(markOf('task-a')).toEqual({ through, read: true, settled: false })
    P().removeItem({ org: org(), task: 'task-b', through: 7, latestAt: at(1) })
    expect(markOf('task-b')).toEqual({ through: 7, removed: true, settled: false })
    answer(0)
    refuse(1)
    await settle()
    // accepted, it stays until an Inbox shows a current answer
    const kept = markOf('task-a')
    expect(kept).toEqual({ through, read: true, settled: true })
    // refused, it ends at once, beside the refusal's toast
    expect(markOf('task-b')).toBeUndefined()
    expect(showToast).toHaveBeenCalledTimes(1)
    if (!kept) throw new Error('no mark')
    P().endInboxMarks([kept])
    expect(markOf('task-a')).toBeUndefined()
  })

  it('settles only its own mark, and an Inbox ends no mark a later write set', async () => {
    const through = Date.parse(at(5))
    P().readItem({ org: org(), task: 'task-a', through, latestAt: at(5) })
    const first = markOf('task-a')
    P().unreadItem({ org: org(), task: 'task-a', through })
    const second = markOf('task-a')
    expect(second).toEqual({ through, read: false, settled: false })
    // the read's answer leaves the unread's mark as it was
    answer(0)
    await settle()
    expect(markOf('task-a')).toBe(second)
    if (!first || !second) throw new Error('no mark')
    P().endInboxMarks([first, second])
    expect(markOf('task-a')).toBe(second)
    answer(1)
    await settle()
    expect(markOf('task-a')).toEqual({ through, read: false, settled: true })
  })

  it('refuses every action first while edits pause, with no mark', async () => {
    // the seat went, so the Inbox's writes pause
    deliver(null)
    await settle()
    const target = { org: org(), task: 'task-a', through: 5 }
    expect(P().unreadItem(target)).toBe(false)
    expect(P().removeItem({ ...target, latestAt: at(5) })).toBe(false)
    expect(P().snoozeItem(target, at(600))).toBe(false)
    expect(P().readItem({ ...target, latestAt: at(5) })).toBe(false)
    expect(sent).toEqual([])
    expect(P().inboxMarks.size).toBe(0)
  })
})

describe("the hold on the watched task's read on open", () => {
  /* Watches task-a's thread, as its window does, and waits for its inbox
     item. */
  async function watchTaskA() {
    P().watchComments('task-a', org())
    await settle()
    expect(P().inboxItem).toMatchObject({ task: 'task-a', state: 'ok', current: true })
  }
  /* The server holds the item read, then gets news on it at `minute`. */
  async function news(minute: number) {
    snapshot.messages = snapshot.messages.map((m) =>
      m.issue_id === 'task-a' ? { ...m, read_at: at(minute - 1) } : m,
    )
    message(`a-${minute}`, 'task-a', minute)
    deliver(snapshot)
    await settle()
  }
  const reads = () => sent.filter((w) => w.name === 'messages:readItem')

  it('holds it for Mark as unread and a snooze of the watched task, and not for the same task id elsewhere', async () => {
    await watchTaskA()
    // another organization's task of the same id holds nothing
    P().unreadItem({ org: OTHER, task: 'task-a', through: 1 })
    P().snoozeItem({ org: OTHER, task: 'task-a', through: 1 }, at(600))
    expect(P().readOnOpen('task-a')).toBe(true)
    answer(2)
    await settle()
    // the watched task's own does, from the moment it goes out
    P().unreadItem({ org: org(), task: 'task-a', through: Date.parse(at(5)) })
    await news(9)
    expect(P().readOnOpen('task-a')).toBe(false)
    P().snoozeItem({ org: org(), task: 'task-a', through: Date.parse(at(9)) }, null)
    expect(P().readOnOpen('task-a')).toBe(false)
    expect(reads()).toHaveLength(1)
  })

  it("is freed by the row's accepted Mark as read, so later news is read on open again", async () => {
    await watchTaskA()
    P().unreadItem({ org: org(), task: 'task-a', through: Date.parse(at(5)) })
    answer(0)
    await settle()
    expect(P().readOnOpen('task-a')).toBe(false)
    P().readItem({ org: org(), task: 'task-a', through: Date.parse(at(5)), latestAt: at(5) })
    // news past the read's cutoff comes while it waits, and the hold turns
    // its read on open away
    await news(7)
    expect(P().readOnOpen('task-a')).toBe(false)
    answer(1)
    await settle()
    // the accepted read freed the hold, so the read it turned away runs
    expect(reads().at(-1)?.args.through).toBe(Date.parse(at(7)))
    await news(9)
    expect(P().readOnOpen('task-a')).toBe(true)
    expect(reads().at(-1)?.args).toEqual({
      org_id: org(),
      issue_id: 'task-a',
      through: Date.parse(at(9)),
    })
  })

  it("is freed by the row's accepted Mark as read once a Mark as unread sent after it is refused, in either order", async () => {
    await watchTaskA()
    const through = Date.parse(at(5))
    const target = { org: org(), task: 'task-a', through }
    // Mark as unread, accepted, holds the read on open
    P().unreadItem(target)
    answer(0)
    await settle()
    // the row's Mark as read goes out, then Mark as unread, which the
    // server refuses before it accepts the read
    P().readItem({ ...target, latestAt: at(5) })
    P().unreadItem(target)
    refuse(2)
    await settle()
    answer(1)
    await settle()
    // the server holds the task read, so later news is read on open
    await news(9)
    expect(P().readOnOpen('task-a')).toBe(true)
    answer(3)
    await settle()
    // and the same with the read accepted first and the unread refused after
    P().unreadItem({ ...target, through: Date.parse(at(9)) })
    answer(4)
    await settle()
    P().readItem({ ...target, through: Date.parse(at(9)), latestAt: at(9) })
    P().unreadItem({ ...target, through: Date.parse(at(9)) })
    answer(5)
    await settle()
    // the newer unread still waits, so it holds
    await news(12)
    expect(P().readOnOpen('task-a')).toBe(false)
    refuse(6)
    await settle()
    expect(reads().at(-1)?.args).toEqual({
      org_id: org(),
      issue_id: 'task-a',
      through: Date.parse(at(12)),
    })
  })

  it("stays for a Mark as unread that went out after the row's Mark as read, the newer choice", async () => {
    await watchTaskA()
    // the row's Mark as read goes out, then Mark as unread, and the server
    // answers them in that order
    P().readItem({ org: org(), task: 'task-a', through: Date.parse(at(5)), latestAt: at(5) })
    P().unreadItem({ org: org(), task: 'task-a', through: Date.parse(at(5)) })
    answer(0)
    await settle()
    answer(1)
    await settle()
    await news(9)
    expect(P().readOnOpen('task-a')).toBe(false)
    expect(reads()).toHaveLength(1)
  })
})

describe('Mark all as read and Remove all read', () => {
  /* A second seat, in organization OTHER, with an unread message about its
     own task-c. */
  async function secondSeat() {
    const me = snapshot.profiles[0]
    snapshot.orgs.push({ ...snapshot.orgs[0], id: OTHER, slug: 'other', name: 'Other' })
    snapshot.profiles.push({ ...me, id: 'me-other', org_id: OTHER })
    snapshot.myProfileIds.push('me-other')
    snapshot.issues.push({ ...snapshot.issues[0], id: 'task-c', org_id: OTHER, num: 1 })
    message('c-1', 'task-c', 3, { org_id: OTHER, recipient_id: 'me-other' })
    deliver(snapshot)
    await settle()
  }
  const shown = (o: string, task: string, read: boolean, snoozed = false) => ({
    org: o,
    task,
    through: 100,
    read,
    snoozed,
  })

  it("marks the shown rows it changes by seat, and ends a refused seat's marks at once", async () => {
    await secondSeat()
    void P().markAllMessagesRead(false, [
      shown(org(), 'task-a', false),
      shown(org(), 'task-b', true),
      shown(OTHER, 'task-c', false),
      shown(OTHER, 'task-d', false, true),
    ])
    await settle()
    // the unread rows that are not snoozed, read at their cutoff
    expect([...P().inboxMarks.keys()].sort()).toEqual([`${org()}:task-a`, `${OTHER}:task-c`])
    expect(markOf('task-c', OTHER)).toEqual({ through: 100, read: true, settled: false })
    const byOrg = (o: string) => sent.findIndex((w) => w.args.org_id === o)
    sent[byOrg(org())].resolve({ marked: 2, ids: ['a-1', 'a-5'], hasMore: false, before: 1 })
    refuse(byOrg(OTHER))
    await settle()
    expect(markOf('task-a')).toEqual({ through: 100, read: true, settled: true })
    expect(markOf('task-c', OTHER)).toBeUndefined()
  })

  it('ends the marks of a run a fault stops', async () => {
    let fault = () => {}
    lanes.fault = new Promise<void>((resolve) => {
      fault = resolve
    })
    void P().markAllMessagesRead(false, [shown(org(), 'task-a', false)])
    await settle()
    expect(markOf('task-a')).toEqual({ through: 100, read: true, settled: false })
    // the run rejects with a fault
    fault()
    await settle()
    expect(P().inboxMarks.size).toBe(0)
    expect(P().inboxBulk).toBeNull()
    expect(showToast).toHaveBeenCalledWith(
      'Mark all as read stopped after a fault in Qivo. What it already did stays done.',
      'error',
    )
  })

  it('marks the read rows that are not snoozed removed', async () => {
    void P().deleteReadMessages(false, [
      shown(org(), 'task-a', false),
      shown(org(), 'task-b', true),
      shown(org(), 'task-e', true, true),
    ])
    await settle()
    expect([...P().inboxMarks.entries()]).toEqual([
      [`${org()}:task-b`, { through: 100, removed: true, settled: false }],
    ])
  })

  it('runs a long action on the lanes every large action shares, and a short one on its own', async () => {
    const { LANE_POOL } = await import('../lib/batchRunner')
    void P().markAllMessagesRead(false, [])
    await settle()
    expect(sent.filter((w) => w.name === 'messages:markAllRead')).toHaveLength(1)
    // a short action leaves both shared places free
    const free = [LANE_POOL.take(), LANE_POOL.take()]
    expect(free.every((taken) => typeof taken === 'function')).toBe(true)
    for (const taken of free) if (typeof taken === 'function') taken()
    sent[0].resolve({ marked: 2, ids: ['a-1', 'a-5'], hasMore: false, before: 1 })
    await settle()
    reach = 'many'
    void P().markAllMessagesRead(false, [])
    await settle()
    expect(sent.filter((w) => w.name === 'messages:markAllRead')).toHaveLength(2)
    // a long one holds one of the two, so another large action waits for the second
    const first = LANE_POOL.take()
    const second = LANE_POOL.take()
    expect(typeof first).toBe('function')
    expect(second).toBeInstanceOf(Promise)
    if (typeof first === 'function') first()
    const release = await second
    release?.()
    sent[1].resolve({ marked: 2, ids: ['a-1', 'a-5'], hasMore: false, before: 1 })
    await settle()
  })
})
