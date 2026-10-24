import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Id } from '../../convex/_generated/dataModel'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* Edits pause while Qivo cannot save (lib/syncStatus), and every sent change
   is noted until the server answers (lib/unconfirmedNote). The network
   double keeps every mutation pending until a test settles it, and the test
   drives the sync status the way the Convex socket would. */

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
// The note of the page under test. Each boot opens a new page, and every
// other page has closed (Web Locks). Mocked modules outlive resetModules, so
// the mock forwards to the page's own note.
const page = vi.hoisted(() => ({
  note: null as null | ReturnType<typeof import('../lib/unconfirmedNote')['createUnconfirmedNote']>,
}))
vi.mock('../lib/unconfirmedNote', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/unconfirmedNote')>()
  const open = () =>
    (page.note = original.createUnconfirmedNote({
      storage: () => localStorage,
      page: crypto.randomUUID(),
      livePages: async () => new Set(),
    }))
  return {
    ...original,
    unconfirmedNote: {
      add: (...args: Parameters<NonNullable<typeof page.note>['add']>) =>
        (page.note ?? open()).add(...args),
      forgetAll: () => (page.note ?? open()).forgetAll(),
      collect: (scopes: Iterable<string>) => (page.note ?? open()).collect(scopes),
    },
  }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(async () => {}),
}))

type Sent = {
  name: string
  args: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const UP = { connected: true, everConnected: true }
const DOWN = { connected: false, everConnected: true }

describe('the pause while Qivo cannot save', () => {
  let store: typeof import('./planner')
  let status: typeof import('../lib/syncStatus')
  let snapshot: Snapshot
  let sent: Sent[]
  let showToast: ReturnType<typeof vi.fn>
  let storage: Map<string, string>
  let reload: ReturnType<typeof vi.fn>
  let probes: (() => void)[] = []
  let snapshotFail: (error: Error) => void = () => {}
  const subscription = () => ({ fail: snapshotFail })

  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  const sentNames = () => sent.map((request) => request.name)
  const notes = () =>
    [...storage.entries()].filter(([key]) => key.startsWith('qivo.unconfirmed.v1:'))

  /** Loads the store as a new page would, on the same browser storage. */
  async function boot() {
    vi.resetModules()
    page.note = null
    status = await import('../lib/syncStatus')
    store = await import('./planner')
    await store.initStore()
    probes = []
    status.syncStatus.setProbe(() => new Promise<void>((resolve) => probes.push(resolve)))
    status.syncStatus.setSocket(UP)
    await answerProbe()
  }
  /** Answers the newest probe query, as the server would. */
  async function answerProbe() {
    probes.at(-1)?.()
    await settle()
  }
  async function goOffline() {
    status.syncStatus.setSocket(DOWN)
    vi.advanceTimersByTime(status.OFFLINE_DELAY_MS)
    await settle()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    demo.on = false
    showToast = vi.fn()
    vi.stubGlobal('window', { showToast, setTimeout, clearTimeout })
    reload = vi.fn()
    vi.stubGlobal('location', { reload })
    storage = new Map()
    vi.stubGlobal('localStorage', {
      get length() {
        return storage.size
      },
      key: (i: number) => [...storage.keys()][i] ?? null,
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    snapshot = plannerFixture()
    const [org] = snapshot.orgs
    const [me] = snapshot.profiles
    snapshot.issues.push({
      id: 'task-a',
      org_id: org.id,
      project_id: snapshot.projects[0].id,
      num: 12,
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
    snapshot.attachments.push({
      id: 'file-a',
      issue_id: 'task-a',
      name: 'plot.png',
      mime: 'image/png',
      size_bytes: 1024,
      storage_id: 'storage-file-a' as Id<'_storage'>,
      inline: false,
      created_at: '2026-09-14T08:00:00.000Z',
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
    sent = []
    network.query.mockResolvedValue(null)
    network.onUpdate.mockImplementation((ref, _args, deliver, fail) => {
      if (getFunctionName(ref) === 'workspace:whole') {
        snapshotFail = fail
        deliver(structuredClone(snapshot))
      }
      return vi.fn()
    })
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      return new Promise((resolve, reject) => sent.push({ name, args, resolve, reject }))
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('refuses every edit offline before it paints, with one sentence, and sends nothing', async () => {
    await boot()
    const { P } = store
    await goOffline()
    expect(P.savePause()).toEqual({ kind: 'offline', waiting: 0 })
    expect(P.editsPaused()).toBe(true)
    const [task] = P.issues
    expect(await P.updateIssue(task.id, { status: 'progress' })).toBe(false)
    expect(await P.addComment('task-a', 'Soak run finished')).toBe(false)
    // the read that opening a task sends says nothing, a read the person asks for says why
    expect(P.markMessagesRead(['message-a'], { quiet: true })).toBe(false)
    expect(showToast).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(P.markMessagesRead(['message-a'])).toBe(false)
    P.setIssueSubscribed(task.id, true)
    await settle()
    expect(sent).toEqual([])
    expect(P.issueById[task.id].status).toBe('todo')
    expect(P.issueById[task.id].subscribed).toBe(false)
    expect(P.messages.find((message) => message.id === 'message-a')?.read).toBeFalsy()
    expect(showToast).toHaveBeenCalledWith(store.OFFLINE_TEXT, 'error')
    expect(showToast).toHaveBeenCalledTimes(2)
    expect(notes()).toEqual([])
  })

  it('counts a change sent before the drop, lets it save on reconnect and then ends the pause', async () => {
    await boot()
    const { P } = store
    const [task] = P.issues
    void P.updateIssue(task.id, { status: 'progress' })
    await goOffline()
    expect(P.savePause()).toEqual({ kind: 'offline', waiting: 1 })
    expect(P.hasUnconfirmed()).toBe(true)
    status.syncStatus.setSocket(UP)
    sent[0].resolve(null)
    await settle()
    // the writes settled, and the pause holds until the server answers the probe
    expect(P.savePause()?.kind).toBe('offline')
    await answerProbe()
    expect(P.savePause()).toBeNull()
    expect(P.hasUnconfirmed()).toBe(false)
    expect(P.issueById[task.id].status).toBe('progress')
    expect(showToast).toHaveBeenCalledWith('Back online. Editing is on again.', 'success')
  })

  it('pauses after a write waits too long on a connected socket and ends when it settles', async () => {
    await boot()
    const { P } = store
    const [task] = P.issues
    void P.updateIssue(task.id, { status: 'progress' })
    vi.advanceTimersByTime(status.SLOW_SAVE_MS)
    expect(P.savePause()).toEqual({ kind: 'slow', waiting: 1 })
    expect(await P.updateIssue(task.id, { priority: 'high' })).toBe(false)
    expect(showToast).toHaveBeenCalledWith(store.SLOW_TEXT, 'error')
    sent[0].resolve(null)
    await settle()
    expect(P.savePause()).toBeNull()
    expect(sentNames()).toEqual(['issues:update'])
  })

  it('sends a slow preference save again when it fails and the pause ends', async () => {
    await boot()
    store.P.saveUI({ view: 'kanban' })
    vi.advanceTimersByTime(600)
    expect(sentNames()).toEqual(['prefs:save'])
    vi.advanceTimersByTime(status.SLOW_SAVE_MS)
    expect(store.P.savePause()?.kind).toBe('slow')
    sent[0].reject(new Error('Server error'))
    await settle()
    expect(store.P.savePause()).toBeNull()
    vi.advanceTimersByTime(0)
    expect(sentNames()).toEqual(['prefs:save', 'prefs:save'])
  })

  it('notes each sent change without its text, and clears it on an answer', async () => {
    await boot()
    const { P } = store
    const [task] = P.issues
    void P.updateIssue(task.id, { description: 'Secret plans for the launch' })
    void P.addComment('task-a', 'Private remark')
    await settle()
    const stored = notes()
    expect(stored).toHaveLength(1)
    expect(JSON.parse(stored[0][1])).toEqual([
      { task: 'QN-12', what: 'description', id: '1', at: expect.any(Number) },
      { task: 'QN-12', what: 'comment', id: '2', at: expect.any(Number) },
    ])
    expect(stored[0][1]).not.toMatch(/Secret|Private/)
    sent[0].resolve(null)
    sent[1].reject(new ConvexError({ code: 'forbidden', message: 'no' }))
    await settle()
    expect(notes()).toEqual([])

    // a removal names its task, though its paint took the row away first
    store.P.removeAttachment('file-a')
    await settle()
    expect(JSON.parse(notes()[0][1])).toEqual([
      { task: 'QN-12', what: 'attachment removal', id: '3', at: expect.any(Number) },
    ])
    // a new task has no key until the server numbers it
    void P.addIssue({ title: 'Fresh task', project: snapshot.projects[0].id })
    await settle()
    expect(JSON.parse(notes()[0][1]).at(-1)).toMatchObject({ task: null, what: 'a new task' })
  })

  it('leaves the read that opening a task sends out of the count and the note', async () => {
    await boot()
    store.P.markMessagesRead(['message-a'], { quiet: true })
    await settle()
    expect(sentNames()).toEqual(['messages:markRead'])
    expect(store.P.hasUnconfirmed()).toBe(false)
    expect(notes()).toEqual([])
  })

  it('signs out past a waiting change only on a second press, and then clears every note', async () => {
    await boot()
    const { P } = store
    const [task] = P.issues
    void P.updateIssue(task.id, { title: 'Recalibrate' })
    await settle()
    storage.set('qivo.unconfirmed.v1:org-8:someone-else:closed-page', '[]')
    P.signOut()
    expect(showToast).toHaveBeenLastCalledWith(
      '1 change is not saved yet. Press Sign out again to sign out and lose it.',
      'error',
    )
    expect(reload).not.toHaveBeenCalled()
    expect(notes()).toHaveLength(2)
    P.signOut()
    // the notes go only once the server has ended the session
    expect(notes()).toHaveLength(2)
    await settle()
    expect(notes()).toEqual([])
    expect(reload).toHaveBeenCalled()
  })

  it('keeps the person signed in and every note when the server could not sign them out', async () => {
    await boot()
    const { P } = store
    const auth = await import('../lib/auth')
    const { SignOutFailed, SIGN_OUT_FAILED } = await import('../lib/authSession')
    let refuse = () => {}
    vi.mocked(auth.signOut).mockImplementationOnce(
      () => new Promise((_, reject) => (refuse = () => reject(new SignOutFailed()))),
    )
    storage.set('qivo.unconfirmed.v1:org-8:someone-else:closed-page', '[]')
    P.signOut()
    // a second press while the first runs sends no second request
    P.signOut()
    expect(auth.signOut).toHaveBeenCalledTimes(1)
    refuse()
    await settle()
    expect(showToast).toHaveBeenLastCalledWith(SIGN_OUT_FAILED, 'error')
    expect(notes()).toHaveLength(1)
    expect(reload).not.toHaveBeenCalled()
    // the next press tries again
    P.signOut()
    expect(auth.signOut).toHaveBeenCalledTimes(2)
    await settle()
    expect(reload).toHaveBeenCalled()
  })

  it('keeps the close warning armed after leaving the demo, which can start again in this page', async () => {
    demo.on = true
    await boot()
    const { installLeaveGuard } = await import('../lib/leaveGuard')
    const win = new EventTarget() as Window
    installLeaveGuard(() => true, win)
    store.P.signOut()
    const event = new Event('beforeunload', { cancelable: true })
    win.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('says why a credential revoke is refused offline', async () => {
    await boot()
    await goOffline()
    expect(await store.P.revokeMcpToken('token-a')).toBe(false)
    expect(showToast).toHaveBeenCalledWith(store.OFFLINE_TEXT, 'error')
    expect(sent).toEqual([])
  })

  it('does not say editing is on again while snapshot trouble still pauses it', async () => {
    await boot()
    await goOffline()
    subscription().fail(new Error('[CONVEX Q(workspace:whole)] Server Error'))
    status.syncStatus.setSocket(UP)
    await answerProbe()
    expect(store.P.savePause()).toBeNull()
    expect(showToast).toHaveBeenCalledWith('Back online.', 'success')
  })

  it('tells the next start about a change no page heard back about, once', async () => {
    await boot()
    const [task] = store.P.issues
    void store.P.updateIssue(task.id, { description: 'Never confirmed' })
    await settle()
    expect(notes()).toHaveLength(1)
    // the page closed with the write unanswered
    await boot()
    await settle()
    expect(store.P.unconfirmedReport()).toBe(
      'Qivo closed before it could confirm 1 change to QN-12 (description). Check the task.',
    )
    expect(notes()).toEqual([])
    store.P.dismissUnconfirmedReport()
    await boot()
    await settle()
    expect(store.P.unconfirmedReport()).toBeNull()
  })
})
