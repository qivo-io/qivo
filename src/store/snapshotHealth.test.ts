import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* Snapshot trouble is the live snapshot query failing after the first
   delivery (plan item 8). The network double captures each snapshot
   subscription's two callbacks, and every other mutation stays pending until
   a test settles it. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const demo = vi.hoisted(() => ({ on: false, ended: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/demoMode', () => ({
  get DEMO_MODE() {
    return demo.on
  },
  notifyDemoEnded: demo.ended,
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

type Subscription = {
  deliver: (snap: Snapshot | null) => void
  fail: (error: Error) => void
  unsubscribe: ReturnType<typeof vi.fn>
}
type Sent = { name: string; resolve: (value: unknown) => void; reject: (error: Error) => void }

const QUERY_FAILURE =
  '[CONVEX Q(snapshot:forMe)] [Request ID: 3f9c2a71] Server Error\n  Called by client'

describe('snapshot trouble', () => {
  let store: typeof import('./planner')
  let snapshot: Snapshot
  let subscriptions: Subscription[]
  let sent: Sent[]
  let showToast: ReturnType<typeof vi.fn>
  let firstDelivery: 'deliver' | 'fail'

  const live = () => subscriptions[subscriptions.length - 1]
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  const sentNames = () => sent.map((request) => request.name)

  async function boot() {
    store = await import('./planner')
    await store.initStore()
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    demo.on = false
    showToast = vi.fn()
    vi.stubGlobal('window', { showToast, setTimeout, clearTimeout })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    snapshot = plannerFixture()
    const [org] = snapshot.orgs
    const [me] = snapshot.profiles
    snapshot.issues.push({
      id: 'task-a',
      org_id: org.id,
      project_id: snapshot.projects[0].id,
      num: 1,
      title: 'Calibrate the sensor',
      description: '',
      status: 'todo',
      priority: 'medium',
      created_at: '2026-09-14T08:00:00.000Z',
      updated_at: '2026-09-14T08:00:00.000Z',
      paused: false,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    snapshot.messages.push({
      id: 'message-a',
      org_id: org.id,
      recipient_id: me.id,
      issue_id: 'task-a',
      issue_title: 'Calibrate the sensor',
      kind: 'change',
      detail: 'Status changed',
      created_at: '2026-09-14T08:00:00.000Z',
    })
    subscriptions = []
    sent = []
    firstDelivery = 'deliver'
    network.query.mockResolvedValue(null)
    network.onUpdate.mockImplementation((ref, _args, deliver, fail) => {
      const unsubscribe = vi.fn()
      if (getFunctionName(ref) === 'snapshot:forMe') {
        subscriptions.push({ deliver, fail, unsubscribe })
        if (subscriptions.length === 1) {
          if (firstDelivery === 'deliver') deliver(structuredClone(snapshot))
          else fail(new Error(QUERY_FAILURE))
        }
      }
      return unsubscribe
    })
    network.mutation.mockImplementation((ref) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      return new Promise((resolve, reject) => sent.push({ name, resolve, reject }))
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('records a mid-session failure with the last good time and ends it on the next delivery', async () => {
    await boot()
    const { P } = store
    expect(P.snapshotTrouble()).toBeNull()
    live().fail(new Error(QUERY_FAILURE))
    expect(P.snapshotTrouble()).toMatchObject({
      kind: 'failed',
      asOf: snapshot.delivered_at,
      retrying: false,
      detail: '[CONVEX Q(snapshot:forMe)] [Request ID: 3f9c2a71] Server Error',
    })
    expect(P.editsPaused()).toBe(true)
    const next = structuredClone(snapshot)
    next.issues[0].title = 'Calibrate the sensor again'
    next.delivered_at = '2026-09-15T09:00:00.000Z'
    live().deliver(next)
    expect(P.snapshotTrouble()).toBeNull()
    expect(P.issues[0].title).toBe('Calibrate the sensor again')
    expect(showToast).toHaveBeenCalledWith('Qivo is up to date again.', 'success')
  })

  it('tells a lost sign-in apart from other failures', async () => {
    await boot()
    live().fail(new ConvexError({ code: 'forbidden', message: 'not signed in' }))
    expect(store.P.snapshotTrouble()?.kind).toBe('signed_out')
    live().fail(new ConvexError({ code: 'forbidden', message: 'not a member' }))
    expect(store.P.snapshotTrouble()?.kind).toBe('failed')
  })

  it('pauses shared edits before they are sent and keeps saving personal state', async () => {
    await boot()
    const { P } = store
    live().fail(new Error(QUERY_FAILURE))
    const [task] = P.issues
    P.updateIssue(task.id, { status: 'progress' })
    await settle()
    expect(sentNames()).not.toContain('issues:update')
    expect(P.issueById[task.id].status).toBe('todo')
    expect(showToast).toHaveBeenCalledWith(store.PAUSED_TEXT, 'error')
    P.markMessagesRead(['message-a'])
    P.saveUI({ view: 'kanban' })
    vi.advanceTimersByTime(600)
    await settle()
    expect(sentNames()).toEqual(['messages:markRead', 'prefs:save'])
  })

  it('refuses paused edits before their paint, so saved personal state stays on screen', async () => {
    await boot()
    const { P } = store
    live().fail(new Error(QUERY_FAILURE))
    P.markMessagesRead(['message-a'])
    sent[0].resolve(null)
    await settle()
    const read = () => P.messages.find((message) => message.id === 'message-a')?.read
    expect(read()).toBe(true)
    const [task] = P.issues
    const project = snapshot.projects[0].id
    const teams = P.teams.length
    P.updateIssue(task.id, { status: 'progress' })
    P.archiveIssue(task.id)
    P.addLabel({ name: 'Bench' })
    P.setOrg({ name: 'Renamed Labs' })
    P.addTeam('Field crew')
    P.updateProject(project, { name: 'Renamed project' })
    P.removeProject(project)
    await settle()
    // nothing was painted, so no rollback took the saved read mark away
    expect(read()).toBe(true)
    expect(sentNames()).toEqual(['messages:markRead'])
    expect(P.issueById[task.id].status).toBe('todo')
    expect(P.labels).toHaveLength(0)
    expect(P.org.name).toBe('Testbed Labs')
    expect(P.teams).toHaveLength(teams)
    expect(P.project(project)?.name).toBe('Task creation fixture')
    // one action can reach several mutators, so the pause toasts once
    expect(showToast.mock.calls.filter(([text]) => text === store.PAUSED_TEXT)).toHaveLength(1)
  })

  it('pauses Deleted items restores and deletes, and says so on the page', async () => {
    await boot()
    const { P } = store
    live().fail(new Error(QUERY_FAILURE))
    const items = [{ id: 'item-a', org_id: snapshot.orgs[0].id }]
    const restored = await P.restoreDeletedItems(items)
    const purged = await P.purgeDeletedItems(items)
    expect(sentNames()).toEqual([])
    for (const outcome of [restored, purged])
      expect(outcome).toMatchObject({ done: [], failed: ['item-a'], error: store.PAUSED_TEXT })
  })

  it('still takes access away while other edits pause', async () => {
    const [org] = snapshot.orgs
    for (const id of ['seat-a', 'seat-b'])
      snapshot.profiles.push({
        id,
        org_id: org.id,
        name: `Member ${id}`,
        initials: 'ME',
        color: '#557733',
        org_role: 'user',
        active: true,
        kind: 'person',
        created_at: '2026-09-14T08:00:00.000Z',
      })
    await boot()
    const { P } = store
    live().fail(new Error(QUERY_FAILURE))
    void P.revokeAgentKey('key-a')
    void P.deleteAgentKey('key-b')
    void P.revokeMcpToken('token-a')
    void P.deleteMcpToken('token-b')
    void P.revokeApiCredential('oauth_connections', 'connection-a')
    void P.revokeOAuthConnection('connection-b')
    expect(P.updateUser('seat-a', { active: false })).toBe(true)
    expect(P.removeUser('seat-b')).toBe(true)
    // a role change or a new credential is an ordinary edit and pauses
    expect(P.updateUser('seat-a', { orgRole: 'viewer' })).toBe(false)
    await expect(P.createMcpToken('Laptop', { access: 'read' })).resolves.toBeNull()
    await settle()
    expect(sentNames()).toEqual([
      'tokens:revokeAgentKey',
      'tokens:deleteAgentKey',
      'tokens:revokeMcpToken',
      'tokens:deleteMcpToken',
      'apiAccess:revoke',
      'oauthConnections:revoke',
      'profiles:deactivate',
      'profiles:remove',
    ])
  })

  it('keeps a paused comment out of the thread so its composer keeps the text', async () => {
    await boot()
    const { P } = store
    P.watchComments('task-a')
    live().fail(new Error(QUERY_FAILURE))
    expect(await P.addComment('task-a', 'Measured on the bench')).toBe(false)
    expect(P.comments).toHaveLength(0)
    expect(sentNames()).not.toContain('comments:create')
    expect(P.refusePausedEdit()).toBe(true)
    expect(showToast).toHaveBeenLastCalledWith(store.PAUSED_TEXT, 'error')
  })

  it('resubscribes on Try again at most once per window', async () => {
    await boot()
    const { P } = store
    live().fail(new Error(QUERY_FAILURE))
    const failed = live()
    P.retrySnapshot()
    expect(failed.unsubscribe).toHaveBeenCalledTimes(1)
    expect(subscriptions).toHaveLength(2)
    expect(getFunctionName(network.onUpdate.mock.lastCall?.[0])).toBe('snapshot:forMe')
    expect(P.snapshotTrouble()?.retrying).toBe(true)
    // the fresh run fails again, and the button stays on "Trying again…"
    live().fail(new Error(QUERY_FAILURE))
    P.retrySnapshot()
    expect(subscriptions).toHaveLength(2)
    vi.advanceTimersByTime(5000)
    expect(P.snapshotTrouble()).toMatchObject({ kind: 'failed', retrying: false })
    P.retrySnapshot()
    expect(subscriptions).toHaveLength(3)
    live().deliver(structuredClone(snapshot))
    expect(P.snapshotTrouble()).toBeNull()
  })

  it('does not retry a lost sign-in, which only a reload can fix', async () => {
    await boot()
    live().fail(new ConvexError({ code: 'forbidden', message: 'not signed in' }))
    store.P.retrySnapshot()
    expect(subscriptions).toHaveLength(1)
  })

  it('ends the trouble when a delivery the paint gate held reaches the screen', async () => {
    await boot()
    const { P } = store
    const [task] = P.issues
    P.updateIssue(task.id, { status: 'progress' })
    expect(sentNames()).toEqual(['issues:update'])
    live().fail(new Error(QUERY_FAILURE))
    const next = structuredClone(snapshot)
    next.issues[0].status = 'progress'
    next.issues[0].title = 'Calibrate the sensor again'
    live().deliver(next)
    // the stale rows are still on screen, so edits stay paused
    expect(P.issues[0].title).toBe('Calibrate the sensor')
    expect(P.editsPaused()).toBe(true)
    sent[0].resolve(null)
    await settle()
    expect(P.snapshotTrouble()).toBeNull()
    expect(P.issues[0].title).toBe('Calibrate the sensor again')
    expect(P.issueById[task.id].status).toBe('progress')
    expect(showToast).toHaveBeenCalledWith('Qivo is up to date again.', 'success')
  })

  it('leaves the boot failure to the sign-in gate, which can boot again', async () => {
    firstDelivery = 'fail'
    store = await import('./planner')
    await expect(store.initStore()).rejects.toThrow('Server Error')
    expect(store.P.snapshotTrouble()).toBeNull()
    const failed = live()
    expect(failed.unsubscribe).toHaveBeenCalledTimes(1)
    // a late error of the failed boot is not trouble, so the next boot's seat
    // claim is sent rather than paused
    failed.fail(new Error(QUERY_FAILURE))
    expect(store.P.snapshotTrouble()).toBeNull()
    const booting = store.initStore()
    await settle()
    expect(subscriptions).toHaveLength(2)
    live().deliver(structuredClone(snapshot))
    await expect(booting).resolves.not.toBeNull()
    const claims = network.mutation.mock.calls.filter(
      ([ref]) => getFunctionName(ref) === 'identity:claimMySeats',
    )
    expect(claims).toHaveLength(2)
  })

  it('keeps the trouble when a null delivery replaces a held recovery', async () => {
    await boot()
    const { P } = store
    const [task] = P.issues
    P.updateIssue(task.id, { status: 'progress' })
    live().fail(new Error(QUERY_FAILURE))
    live().deliver(structuredClone(snapshot))
    live().deliver(null)
    sent[0].resolve(null)
    await settle()
    expect(P.snapshotTrouble()?.kind).toBe('no_access')
    expect(showToast).not.toHaveBeenCalledWith('Qivo is up to date again.', 'success')
  })

  it('keeps the last view and pauses every write but the login’s own when every seat is gone', async () => {
    const [org] = snapshot.orgs
    for (const id of ['seat-a', 'seat-b'])
      snapshot.profiles.push({
        id,
        org_id: org.id,
        name: `Member ${id}`,
        initials: 'ME',
        color: '#557733',
        org_role: 'user',
        active: true,
        kind: 'person',
        created_at: '2026-09-14T08:00:00.000Z',
      })
    await boot()
    const { P } = store
    live().deliver(null)
    expect(P.snapshotTrouble()).toMatchObject({
      kind: 'no_access',
      asOf: snapshot.delivered_at,
      retrying: false,
      detail: '',
    })
    expect(P.issues).toHaveLength(1)
    const [task] = P.issues
    P.updateIssue(task.id, { status: 'progress' })
    P.markMessagesRead(['message-a'])
    P.saveUI({ view: 'kanban' })
    // the writes that take access away or change a seat answer that they
    // were not sent, so their callers announce nothing
    expect(P.updateUser('seat-a', { active: false })).toBe(false)
    expect(P.removeUser('seat-b')).toBe(false)
    expect(P.setMessageRetention(30)).toBe(false)
    void P.revokeMcpToken('token-a')
    P.setAppearance({ mode: 'dark', image_source: 'none' })
    void P.revokeOAuthConnection('connection-a')
    vi.advanceTimersByTime(600)
    await settle()
    // without a seat the server refuses the rest, so only the login's
    // appearance and connected apps go out
    expect(sentNames()).toEqual(['appearance:save', 'oauthConnections:revoke'])
    expect(P.issueById[task.id].status).toBe('todo')
    expect(P.messages.find((message) => message.id === 'message-a')?.read).toBeFalsy()
    expect(P.users.map((user) => user.id)).toEqual(expect.arrayContaining(['seat-a', 'seat-b']))
    expect(showToast).toHaveBeenCalledWith(store.NO_ACCESS_TEXT, 'error')
    expect(showToast).not.toHaveBeenCalledWith(store.PAUSED_TEXT, 'error')
    // a retry cannot bring a seat back
    P.retrySnapshot()
    expect(subscriptions).toHaveLength(1)
  })

  it('reverts an edit the server refuses after every seat is gone', async () => {
    await boot()
    const { P } = store
    const [task] = P.issues
    P.updateIssue(task.id, { status: 'progress' })
    expect(sentNames()).toEqual(['issues:update'])
    live().deliver(null)
    sent[0].reject(
      new ConvexError({ code: 'forbidden', message: 'no profile in this organization' }),
    )
    await settle()
    expect(P.issueById[task.id].status).toBe('todo')
    expect(P.snapshotTrouble()?.kind).toBe('no_access')
  })

  it('ends lost access when a seat comes back', async () => {
    await boot()
    const { P } = store
    live().deliver(null)
    live().deliver(structuredClone(snapshot))
    expect(P.snapshotTrouble()).toBeNull()
    expect(showToast).toHaveBeenCalledWith('Qivo is up to date again.', 'success')
  })

  it('lets the demo end itself when its seat is gone', async () => {
    demo.on = true
    await boot()
    live().deliver(null)
    expect(demo.ended).toHaveBeenCalled()
    expect(store.P.snapshotTrouble()).toBeNull()
    store.disposeDemoStore()
  })

  it('lets the demo end itself instead of reporting trouble', async () => {
    demo.on = true
    await boot()
    live().fail(new ConvexError({ code: 'forbidden', message: 'demo', reason: 'demo_expired' }))
    expect(demo.ended).toHaveBeenCalled()
    expect(store.P.snapshotTrouble()).toBeNull()
    store.disposeDemoStore()
  })
})
