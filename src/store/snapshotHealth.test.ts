import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Id } from '../../convex/_generated/dataModel'
import { DEMO_UNAVAILABLE } from '../../convex/lib/demoRefusals'
import type { Seatless } from '../../convex/lib/workspaceJoin'
import { SEATS_DELETING } from './guard/liveDouble.setup'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* Snapshot trouble is the live snapshot query failing after the first
   delivery (plan item 8). The network double captures each snapshot
   subscription's two callbacks, and every other mutation stays pending until
   a test settles it. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const demo = vi.hoisted(() => ({ on: false, ended: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('./guard/liveDouble.setup')).liveOver(network),
}))
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
  deliver: (snap: Snapshot | Seatless | null) => void
  fail: (error: Error) => void
  unsubscribe: ReturnType<typeof vi.fn>
}
type Sent = { name: string; resolve: (value: unknown) => void; reject: (error: Error) => void }

const QUERY_FAILURE =
  '[CONVEX Q(workspace:whole)] [Request ID: 3f9c2a71] Server Error\n  Called by client'
/* The root part's answer for a member whose only organization deactivated
   them (convex/lib/workspaceParts.ts readRoot). */
const DEACTIVATED: Seatless = { deleting: false, create: 'blocked' }

describe('snapshot trouble', () => {
  let store: typeof import('./planner')
  let snapshot: Snapshot
  let subscriptions: Subscription[]
  let threads: { deliver: (page: unknown) => void; unsubscribe: ReturnType<typeof vi.fn> }[]
  let sent: Sent[]
  let showToast: ReturnType<typeof vi.fn>
  // an error is the boot's failure, else a query failure
  let firstDelivery: 'deliver' | 'fail' | 'deleting' | 'deactivated' | Error

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
    threads = []
    sent = []
    firstDelivery = 'deliver'
    network.query.mockResolvedValue(null)
    network.onUpdate.mockImplementation((ref, _args, deliver, fail) => {
      const unsubscribe = vi.fn()
      if (getFunctionName(ref) === 'workspace:whole') {
        subscriptions.push({ deliver, fail, unsubscribe })
        if (subscriptions.length === 1) {
          if (firstDelivery === 'deliver') deliver(structuredClone(snapshot))
          else if (firstDelivery === 'deleting') deliver(SEATS_DELETING)
          else if (firstDelivery === 'deactivated') deliver(DEACTIVATED)
          else fail(firstDelivery instanceof Error ? firstDelivery : new Error(QUERY_FAILURE))
        }
      } else if (getFunctionName(ref) === 'snapshot:threadComments')
        threads.push({ deliver, unsubscribe })
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
      detail: '[CONVEX Q(workspace:whole)] [Request ID: 3f9c2a71] Server Error',
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
    P.createParent(task.id, 'Sensor work')
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

  it('pauses every write while signed out, before anything paints', async () => {
    await boot()
    const { P } = store
    const [task] = P.issues
    // saved after the last good delivery, so a rollback would take it away
    P.updateIssue(task.id, { status: 'progress' })
    live().fail(new ConvexError({ code: 'forbidden', message: 'not signed in' }))
    sent.splice(0)[0].resolve(null)
    await settle()
    const read = () => P.messages.find((message) => message.id === 'message-a')?.read
    // opening the task reads its messages on its own, and says nothing
    expect(P.markMessagesRead(['message-a'], { quiet: true })).toBe(false)
    expect(read()).toBeFalsy()
    expect(showToast).not.toHaveBeenCalled()
    expect(P.markMessagesRead(['message-a'])).toBe(false)
    P.setIssueSubscribed(task.id, true)
    expect(P.issueById[task.id].subscribed).toBe(false)
    P.createParent(task.id, 'Sensor work')
    P.setAppearance({ mode: 'dark', image_source: 'none' }).catch(() => {})
    P.saveUI({ view: 'kanban' })
    vi.advanceTimersByTime(600)
    await settle()
    expect(sent).toEqual([])
    expect(read()).toBeFalsy()
    expect(P.issueById[task.id].subscribed).toBe(false)
    // nothing was rolled back over the saved edit
    expect(P.issueById[task.id].status).toBe('progress')
    expect(showToast).toHaveBeenCalledWith(store.SIGNED_OUT_TEXT, 'error')
    expect(showToast).not.toHaveBeenCalledWith(store.PAUSED_TEXT, 'error')
  })

  it('keeps a saved task edit when opening a task tries to read its messages without a seat', async () => {
    await boot()
    const { P } = store
    const [task] = P.issues
    P.updateIssue(task.id, { status: 'progress' })
    // the seat went in the same delivery that would have held the edit
    live().deliver(null)
    sent[0].resolve(null)
    await settle()
    expect(P.issueById[task.id].status).toBe('progress')
    P.markMessagesRead(['message-a'], { quiet: true })
    await settle()
    expect(sent).toHaveLength(1)
    expect(P.issueById[task.id].status).toBe('progress')
    expect(P.messages.find((message) => message.id === 'message-a')?.read).toBeFalsy()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('refuses a paused label create even when the name is taken', async () => {
    snapshot.labels.push({
      id: 'label-a',
      org_id: snapshot.orgs[0].id,
      name: 'Firmware',
      name_lower: 'firmware',
      color: '#335577',
      created_at: '2026-09-14T08:00:00.000Z',
    })
    await boot()
    live().fail(new Error(QUERY_FAILURE))
    expect(store.P.addLabel({ name: 'firmware' })).toBeNull()
    expect(showToast).toHaveBeenLastCalledWith(store.PAUSED_TEXT, 'error')
  })

  it('deletes a discarded draft upload quietly once edits resume, unless a description took it', async () => {
    snapshot.attachments.push(
      ...['file-a', 'file-b', 'file-c'].map((id) => ({
        id,
        issue_id: 'task-a',
        name: `${id}.png`,
        mime: 'image/png',
        size_bytes: 1024,
        storage_id: `storage-${id}` as Id<'_storage'>,
        inline: true,
        created_at: '2026-09-14T08:00:00.000Z',
      })),
    )
    await boot()
    const { P } = store
    live().fail(new Error(QUERY_FAILURE))
    P.removeAttachment('file-a', { deferWhilePaused: true })
    P.removeAttachment('file-b', { deferWhilePaused: true })
    expect(showToast).not.toHaveBeenCalled()
    expect(sentNames()).toEqual([])
    // file-b reached a saved description meanwhile, so it stays
    const next = structuredClone(snapshot)
    next.issues[0].description = '![Plot](att:file-b)'
    next.delivered_at = '2026-09-15T09:00:00.000Z'
    live().deliver(next)
    expect(sentNames()).toEqual(['files:removeAttachment'])
    const removed = network.mutation.mock.calls
      .filter(([ref]) => getFunctionName(ref) === 'files:removeAttachment')
      .map(([, args]) => args.id)
    expect(removed).toEqual(['file-a'])
    // a delete that is not a draft upload still says the edit is paused
    live().fail(new Error(QUERY_FAILURE))
    P.removeAttachment('file-c')
    expect(showToast).toHaveBeenLastCalledWith(store.PAUSED_TEXT, 'error')
    expect(sentNames()).toEqual(['files:removeAttachment'])
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
    expect(getFunctionName(network.onUpdate.mock.lastCall?.[0])).toBe('workspace:whole')
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

  it('keeps a comment saved while Try again starts every part afresh until the new thread answers', async () => {
    await boot()
    const { P } = store
    // a threadComments page
    const page = { comments: [], earlier: false }
    P.watchComments('task-a')
    await settle()
    threads[0].deliver(structuredClone(page))
    await settle()
    const saved = P.addComment('task-a', 'Measured on the bench')
    // a thread delivery sent before the save reached the server
    threads[0].deliver(structuredClone(page))
    await settle()
    expect(P.comments.map((c) => c.body)).toEqual(['Measured on the bench'])
    // trouble, then a recovery the waiting save holds off the screen
    live().fail(new Error(QUERY_FAILURE))
    live().deliver(structuredClone(snapshot))
    await settle()
    expect(P.snapshotTrouble()).toMatchObject({ kind: 'failed' })
    // no part failed any more, so Try again starts every part and the
    // thread afresh, and the new ones have answered nothing yet
    P.retrySnapshot()
    expect(subscriptions).toHaveLength(2)
    expect(threads[0].unsubscribe).toHaveBeenCalled()
    sent.find((request) => request.name === 'comments:create')?.resolve(null)
    expect(await saved).toBe(true)
    await settle()
    vi.advanceTimersByTime(0)
    // no delivery after the restart holds the save, so its paint stays
    expect(P.comments.map((c) => c.body)).toEqual(['Measured on the bench'])
  })

  it('does not retry a lost sign-in, which only a reload can fix', async () => {
    await boot()
    live().fail(new ConvexError({ code: 'forbidden', message: 'not signed in' }))
    store.P.retrySnapshot()
    expect(subscriptions).toHaveLength(1)
  })

  it('ends the trouble within a task while a write still waits for its answer', async () => {
    await boot()
    const { P } = store
    const [task] = P.issues
    P.updateIssue(task.id, { status: 'progress' })
    live().fail(new Error(QUERY_FAILURE))
    const next = structuredClone(snapshot)
    next.issues[0].title = 'Calibrate the sensor again'
    live().deliver(next)
    // painted at the latest on a 0 ms timer, with the waiting write on top
    expect(P.snapshotTrouble()).not.toBeNull()
    vi.advanceTimersByTime(0)
    expect(P.snapshotTrouble()).toBeNull()
    expect(P.issues[0].title).toBe('Calibrate the sensor again')
    expect(P.issues[0].status).toBe('progress')
    expect(sentNames()).toEqual(['issues:update'])
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
    // it reads like the edits paused after the seat went
    expect(showToast).toHaveBeenCalledWith(store.NO_ACCESS_TEXT, 'error')
    expect(showToast).not.toHaveBeenCalledWith(
      "You don't have permission for that. Change reverted.",
      'error',
    )
  })

  it("says an edit was refused because the organization's deletion began, seat or no seat", async () => {
    const deleting = () =>
      new ConvexError({ code: 'forbidden', message: 'this organization is being deleted' })
    await boot()
    const { P } = store
    const [task] = P.issues
    // the refusal arrives while the last delivery still holds the seat
    P.updateIssue(task.id, { status: 'progress' })
    sent[0].reject(deleting())
    await settle()
    expect(P.issueById[task.id].status).toBe('todo')
    expect(showToast).toHaveBeenLastCalledWith(store.ORG_DELETING_TEXT, 'error')
    // and once the delivery without the seat came first; past the pause
    // toast's gap, so a second toast shows
    vi.advanceTimersByTime(1_000)
    showToast.mockClear()
    P.updateIssue(task.id, { status: 'review' })
    expect(sent).toHaveLength(2)
    live().deliver(SEATS_DELETING)
    sent[1].reject(deleting())
    await settle()
    expect(P.issueById[task.id].status).toBe('todo')
    expect(showToast).toHaveBeenCalledWith(store.ORG_DELETING_TEXT, 'error')
    // an edit after that delivery pauses before it is sent, in the same words
    vi.advanceTimersByTime(1_000)
    showToast.mockClear()
    P.updateIssue(task.id, { status: 'done' })
    await settle()
    expect(sent).toHaveLength(2)
    expect(showToast).toHaveBeenCalledWith(store.ORG_DELETING_TEXT, 'error')
    expect(showToast).not.toHaveBeenCalledWith(store.NO_ACCESS_TEXT, 'error')
    expect(showToast.mock.calls.map(([text]) => text)).not.toContainEqual(
      expect.stringMatching(/permission/i),
    )
  })

  it('says the organization is being deleted when its deletion holds the last seats, until it is over', async () => {
    await boot()
    const { P } = store
    live().deliver(SEATS_DELETING)
    expect(P.snapshotTrouble()).toMatchObject({
      kind: 'no_access',
      reason: store.ORG_DELETING_TEXT,
    })
    // the last view stays and shows nothing new
    expect(P.issues).toHaveLength(1)
    live().deliver(null)
    expect(P.snapshotTrouble()?.kind).toBe('no_access')
    expect(P.snapshotTrouble()?.reason).toBeUndefined()
  })

  it('boots with no seat and says why when an organization deletion holds the seats', async () => {
    firstDelivery = 'deleting'
    store = await import('./planner')
    await expect(store.initStore()).resolves.toBeNull()
    expect(store.P.seatless()).toEqual({ deleting: true, create: 'after_deletion' })
    expect(store.P.issues).toEqual([])
  })

  it('boots with no seat and says why for a member their organization deactivated', async () => {
    firstDelivery = 'deactivated'
    store = await import('./planner')
    await expect(store.initStore()).resolves.toBeNull()
    expect(store.P.seatless()).toEqual(DEACTIVATED)
  })

  it('says access ended, not a deletion, when the last seat is deactivated mid-session', async () => {
    await boot()
    const { P } = store
    live().deliver(DEACTIVATED)
    expect(P.snapshotTrouble()?.kind).toBe('no_access')
    expect(P.snapshotTrouble()?.reason).toBeUndefined()
    expect(P.issues).toHaveLength(1)
  })

  it("names the organization's deletion for its write while another organization remains", async () => {
    const guest = crypto.randomUUID()
    snapshot.orgs.push({ ...snapshot.orgs[0], id: guest, name: 'Partner Co', slug: 'partner' })
    const seat = { ...snapshot.profiles[0], id: crypto.randomUUID(), org_id: guest }
    snapshot.profiles.push({ ...seat, org_role: 'guest' })
    snapshot.myProfileIds.push(seat.id)
    await boot()
    const { P } = store
    const [task] = P.issues
    P.updateIssue(task.id, { status: 'progress' })
    const restore = P.unarchiveProject(snapshot.projects[0].id)
    await settle()
    for (const request of sent)
      request.reject(
        new ConvexError({ code: 'forbidden', message: 'this organization is being deleted' }),
      )
    expect(await restore).toBe(false)
    await settle()
    expect(showToast).toHaveBeenCalledWith(
      'This organization is being deleted. Change reverted.',
      'error',
    )
    expect(showToast).toHaveBeenCalledWith(store.ORG_DELETING_TEXT, 'error')
    expect(showToast.mock.calls.map(([text]) => text)).not.toContainEqual(
      expect.stringMatching(/permission/i),
    )
  })

  it('words a restore or delete refused after every seat is gone like the access notice', async () => {
    await boot()
    const { P } = store
    const items = [{ id: 'item-a', org_id: snapshot.orgs[0].id }]
    const restore = P.unarchiveProject(snapshot.projects[0].id)
    const restored = P.restoreDeletedItems(items)
    const purged = P.purgeDeletedItems(items)
    await settle()
    expect(sentNames()).toEqual([
      'projects:unarchive',
      'deletedItems:restore',
      'deletedItems:purge',
    ])
    live().deliver(null)
    const lost = new ConvexError({ code: 'forbidden', message: 'no profile in this organization' })
    for (const request of sent) request.reject(lost)
    expect(await restore).toBe(false)
    expect(showToast).toHaveBeenCalledWith(store.NO_ACCESS_TEXT, 'error')
    for (const outcome of [await restored, await purged])
      expect(outcome).toMatchObject({ failed: ['item-a'], error: store.NO_ACCESS_TEXT })
    // with a seat, forbidden still reads as a permission refusal, once its
    // organization's parts loaded again
    live().deliver(structuredClone(snapshot))
    await settle()
    const again = P.unarchiveProject(snapshot.projects[0].id)
    await settle()
    sent[sent.length - 1].reject(
      new ConvexError({ code: 'forbidden', message: 'no permission on this project' }),
    )
    expect(await again).toBe(false)
    expect(showToast).toHaveBeenLastCalledWith("You don't have permission for that", 'error')
  })

  it('words a refusal for a lost seat like the access notice before the snapshot says so', async () => {
    await boot()
    const { P } = store
    const items = [{ id: 'item-a', org_id: snapshot.orgs[0].id }]
    const restore = P.unarchiveProject(snapshot.projects[0].id)
    const restored = P.restoreDeletedItems(items)
    P.addProject({ type: 'meta', key: 'NEW', name: 'New' })
    await settle()
    // the refusals arrive while the last delivery still holds the seat
    const lost = new ConvexError({ code: 'forbidden', message: 'no profile in this organization' })
    for (const request of sent) request.reject(lost)
    expect(await restore).toBe(false)
    expect(showToast).toHaveBeenCalledWith(store.NO_ACCESS_TEXT, 'error')
    expect(await restored).toMatchObject({ failed: ['item-a'], error: store.NO_ACCESS_TEXT })
    await settle()
    expect(sentNames()).toContain('projects:create')
    expect(showToast.mock.calls.map(([text]) => text)).not.toContainEqual(
      expect.stringMatching(/permission|no profile/i),
    )
  })

  it('words a lost seat as a permission refusal while another organization remains', async () => {
    const guest = crypto.randomUUID()
    snapshot.orgs.push({ ...snapshot.orgs[0], id: guest, name: 'Partner Co', slug: 'partner' })
    const seat = { ...snapshot.profiles[0], id: crypto.randomUUID(), org_id: guest }
    snapshot.profiles.push({ ...seat, org_role: 'guest' })
    snapshot.myProfileIds.push(seat.id)
    await boot()
    const { P } = store
    const restore = P.unarchiveProject(snapshot.projects[0].id)
    await settle()
    sent[0].reject(
      new ConvexError({ code: 'forbidden', message: 'no profile in this organization' }),
    )
    expect(await restore).toBe(false)
    expect(showToast).toHaveBeenLastCalledWith("You don't have permission for that", 'error')
    // the same when the delivery that drops the seat arrives first
    const again = P.unarchiveProject(snapshot.projects[0].id)
    await settle()
    const left = structuredClone(snapshot)
    left.myProfileIds = [seat.id]
    left.delivered_at = '2026-09-15T09:00:00.000Z'
    live().deliver(left)
    sent[sent.length - 1].reject(
      new ConvexError({ code: 'forbidden', message: 'no profile in this organization' }),
    )
    expect(await again).toBe(false)
    expect(showToast).toHaveBeenLastCalledWith("You don't have permission for that", 'error')
    expect(showToast).not.toHaveBeenCalledWith(store.NO_ACCESS_TEXT, 'error')
  })

  it('deletes a connected app the server no longer has, with no error toast', async () => {
    await boot()
    const { P } = store
    const gone = P.revokeOAuthConnection('connection-a')
    const refused = P.revokeOAuthConnection('connection-b')
    await settle()
    sent[0].reject(new ConvexError({ code: 'not_found', message: 'Connection not found.' }))
    sent[1].reject(new ConvexError({ code: 'bad_request', message: 'broken' }))
    expect(await gone).toBe(true)
    // the page says a failed deletion itself, so the store toasts nothing
    expect(await refused).toBe(false)
    await settle()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('keeps lost access through a query fault until a seat comes back', async () => {
    await boot()
    const { P } = store
    live().deliver(null)
    live().fail(new Error(QUERY_FAILURE))
    expect(P.snapshotTrouble()?.kind).toBe('no_access')
    // read marks need a seat, so they stay paused
    P.markMessagesRead(['message-a'])
    await settle()
    expect(sentNames()).toEqual([])
    // a lost sign-in still says so
    live().fail(new ConvexError({ code: 'forbidden', message: 'not signed in' }))
    expect(P.snapshotTrouble()?.kind).toBe('signed_out')
  })

  it('ends lost access when a seat comes back', async () => {
    await boot()
    const { P } = store
    live().deliver(null)
    live().deliver(structuredClone(snapshot))
    // the seat's organization loads its parts again first
    await settle()
    expect(P.snapshotTrouble()).toBeNull()
    expect(showToast).toHaveBeenCalledWith('Qivo is up to date again.', 'success')
  })

  it('lets the demo end itself when its seat is gone', async () => {
    demo.on = true
    await boot()
    live().deliver(null)
    // no refusal, so the gate says the demo expired
    expect(demo.ended).toHaveBeenCalledWith()
    expect(store.P.snapshotTrouble()).toBeNull()
    store.disposeDemoStore()
  })

  /* The demo gate shows the ending it reads from the refusal the store ends
     the demo with (lib/demoSession.ts demoEnding), so each passes it on. */
  const unavailable = () =>
    new ConvexError({
      code: 'forbidden',
      message: DEMO_UNAVAILABLE.mainDeployment,
      reason: 'demo_unavailable',
    })

  it('lets the demo end itself with the refusal instead of reporting trouble', async () => {
    demo.on = true
    await boot()
    const expired = new ConvexError({ code: 'forbidden', message: 'demo', reason: 'demo_expired' })
    live().fail(expired)
    expect(demo.ended).toHaveBeenCalledWith(expired)
    expect(store.P.snapshotTrouble()).toBeNull()
    store.disposeDemoStore()
  })

  it('ends the demo with the refusal of a write', async () => {
    demo.on = true
    await boot()
    const { P } = store
    P.updateIssue(P.issues[0].id, { status: 'progress' })
    expect(sentNames()).toEqual(['issues:update'])
    const refusal = unavailable()
    sent[0].reject(refusal)
    await settle()
    expect(demo.ended).toHaveBeenCalledWith(refusal)
    store.disposeDemoStore()
  })

  it('ends the demo with the refusal of its boot', async () => {
    demo.on = true
    const refusal = unavailable()
    firstDelivery = refusal
    store = await import('./planner')
    await expect(store.initStore()).rejects.toBe(refusal)
    expect(demo.ended).toHaveBeenCalledWith(refusal)
  })
})
