import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'
import type { Row } from './rows'

/* The store's read of one inbox item (store/planner.ts P.readItem), a
   plain write of messages.readItem. Its paint marks read the task's loaded
   messages that are unread, not snoozed and no newer than the item's
   newest, so the Inbox's row turns read at once, and prunes the task to its
   newest message, as the server does; it leaves the rest. The pause
   refuses it before it paints, quietly when asked; a refusal takes its
   paint back. Every call sends, since the once-per-`through` rule is the
   task window's (P.readOnOpen, panels/InboxItemMark.test.tsx). */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('./guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

const at = (minute: number) =>
  new Date(Date.parse('2026-09-14T08:00:00.000Z') + minute * 60_000).toISOString()

describe("the store's read of one inbox item", () => {
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

  const P = () => store.P
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  /* The mark of `task`'s Inbox row, which shows it read at once. */
  const markOf = (task: string) => P().inboxMarks.get(`${snapshot.orgs[0].id}:${task}`)
  const target = (latest: number) => ({
    org: snapshot.orgs[0].id,
    task: 'task-a',
    through: Date.parse(at(latest)),
  })

  function message(id: string, task: string, minute: number, over: Partial<Row<'messages'>> = {}) {
    snapshot.messages.push({
      id,
      org_id: snapshot.orgs[0].id,
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
    message('a-1', 'task-a', 1)
    message('a-5', 'task-a', 5)
    message('b-1', 'task-b', 1)
    sent = []
    network.query.mockResolvedValue(null)
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

  it("marks the task's Inbox row read up to the item's newest, and sends the item read", async () => {
    expect(P().readItem(target(5))).toBe(true)
    expect(markOf('task-a')).toMatchObject({ through: Date.parse(at(5)), read: true })
    // another task's row has no mark
    expect(markOf('task-b')).toBeUndefined()
    expect(sent.map(({ name, args }) => ({ name, args }))).toEqual([
      {
        name: 'messages:readItem',
        args: { org_id: snapshot.orgs[0].id, issue_id: 'task-a', through: Date.parse(at(5)) },
      },
    ])
    // a plain write, so the next call sends again
    expect(P().readItem(target(5))).toBe(true)
    expect(sent).toHaveLength(2)
  })

  it('takes its mark back when the server refuses it', async () => {
    P().readItem(target(5))
    expect(markOf('task-a')).toMatchObject({ read: true })
    sent[0].reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await settle()
    expect(markOf('task-a')).toBeUndefined()
  })

  it('answers false while edits pause and marks nothing, quietly when asked', async () => {
    // the seat went, so the Inbox's writes pause
    deliver(null)
    await settle()
    expect(P().readItem(target(5), { quiet: true })).toBe(false)
    expect(showToast).not.toHaveBeenCalled()
    expect(P().readItem(target(5))).toBe(false)
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(markOf('task-a')).toBeUndefined()
    expect(sent).toEqual([])
  })
})
