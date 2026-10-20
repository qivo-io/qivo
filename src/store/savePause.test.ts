import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* Edits pause while Qivo cannot save (lib/syncStatus), and every sent change
   is noted until the server answers (lib/unconfirmedNote). The network
   double keeps every mutation pending until a test settles it, and the test
   drives the sync status the way the Convex socket would. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
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

const UP = { connected: true, everConnected: true, synced: true }
const DOWN = { connected: false, everConnected: true, synced: false }
const BACK = { connected: true, everConnected: true, synced: false }

describe('the pause while Qivo cannot save', () => {
  let store: typeof import('./planner')
  let status: typeof import('../lib/syncStatus')
  let snapshot: Snapshot
  let sent: Sent[]
  let showToast: ReturnType<typeof vi.fn>
  let storage: Map<string, string>
  let reload: ReturnType<typeof vi.fn>

  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  const sentNames = () => sent.map((request) => request.name)
  const notes = () =>
    [...storage.entries()].filter(([key]) => key.startsWith('qivo.unconfirmed.v1:'))

  /** Loads the store as a new page would, on the same browser storage. */
  async function boot() {
    vi.resetModules()
    status = await import('../lib/syncStatus')
    store = await import('./planner')
    await store.initStore()
    status.syncStatus.setSocket(UP)
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
    network.onUpdate.mockImplementation((ref, _args, deliver) => {
      if (getFunctionName(ref) === 'snapshot:forMe') deliver(structuredClone(snapshot))
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
    status.syncStatus.setSocket(BACK)
    sent[0].resolve(null)
    await settle()
    // the writes settled, and the pause holds until Convex has synced
    expect(P.savePause()?.kind).toBe('offline')
    status.syncStatus.setSocket(UP)
    await settle()
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

  it('notes each sent change without its text, and clears it on an answer or a sign-out', async () => {
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

    void P.updateIssue(task.id, { title: 'Recalibrate' })
    await settle()
    expect(notes()).toHaveLength(1)
    // a change still waiting holds the sign-out back and says why
    P.signOut()
    expect(showToast).toHaveBeenLastCalledWith(
      '1 change is not saved yet. Sign out once it is saved.',
      'error',
    )
    expect(notes()).toHaveLength(1)
    sent[2].resolve(null)
    await settle()
    // a note a page that already closed left is cleared too
    const scope = `${snapshot.orgs[0].id}:${snapshot.profiles[0].id}`
    storage.set(`qivo.unconfirmed.v1:${scope}:closed-page`, '[]')
    P.signOut()
    expect(notes()).toEqual([])
    await settle()
    expect(reload).toHaveBeenCalled()
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
