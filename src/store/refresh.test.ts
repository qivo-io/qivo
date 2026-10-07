import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'
import type { Row } from './rows'

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/demoMode', () => ({ DEMO_MODE: true }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

describe('planner refresh boundaries', () => {
  let store: typeof import('./planner')
  let snapshot: Snapshot
  let browser: EventTarget
  let publish: (snapshot: Snapshot) => void
  let publishComments: (rows: Row<'comments'>[]) => void
  let publishTeamSync: (rows: { issue_id: string; at: string }[]) => void
  let resolve: (value: unknown) => void
  let reject: (reason: unknown) => void

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 4, 23, 59, 59, 500))
    browser = Object.assign(new EventTarget(), { setTimeout, clearTimeout, showToast: vi.fn() })
    vi.stubGlobal('window', browser)
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    snapshot = plannerFixture()
    snapshot.issues.push({
      id: 'task-a',
      org_id: snapshot.orgs[0].id,
      project_id: snapshot.projects[0].id,
      num: 1,
      title: 'Due today',
      description: '',
      status: 'progress',
      priority: 'medium',
      due_date: '2026-10-04',
      start_week: '2026-09-28',
      end_week: '2026-09-28',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      paused: false,
      has_hidden_subtasks: false,
    })
    network.query.mockResolvedValue(null)
    network.mutation.mockImplementation(
      () =>
        new Promise((yes, no) => {
          resolve = yes
          reject = no
        }),
    )
    network.onUpdate.mockImplementation((ref, _args, receive) => {
      if (getFunctionName(ref) === 'snapshot:forMe') {
        publish = receive
        receive(structuredClone(snapshot))
      } else if (getFunctionName(ref) === 'teamSync:lastComments') publishTeamSync = receive
      else publishComments = receive
      return vi.fn()
    })
    store = await import('./planner')
    await store.initStore()
    await Promise.resolve()
  })
  afterEach(() => {
    store?.disposeDemoStore()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  const comment = (body = 'Original'): Row<'comments'> => ({
    id: 'comment-a',
    issue_id: 'task-a',
    body,
    author: snapshot.profiles[0].id,
    created_at: '2026-10-04T12:00:00.000Z',
  })
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }

  it('refreshes overdue status and cancels stale grid gestures without a server delivery', () => {
    const { P } = store
    const epoch = P.gridEpoch
    expect(P.TODAY_ISO).toBe('2026-10-04')
    expect(P.delayOf(P.issues[0])?.status).toBe('ok')
    vi.advanceTimersByTime(500)
    expect(P.TODAY_ISO).toBe('2026-10-05')
    expect(P.delayOf(P.issues[0])?.status).toBe('late')
    expect(P.gridEpoch).toBe(epoch + 1)
    expect(P.isoFromDate(P.weekToDate(P.issues[0].start!))).toBe('2026-09-28')
    vi.setSystemTime(new Date(2026, 9, 6, 9))
    browser.dispatchEvent(new Event('focus'))
    expect(P.TODAY_ISO).toBe('2026-10-06')
    expect(P.gridEpoch).toBe(epoch + 1)
  })

  it('keeps task, project and delay identities on comment delivery and successful writes', async () => {
    const { P } = store
    const tasks = P.issues
    const project = P.project(snapshot.projects[0].id)
    const delay = P.delayOf(tasks[0])
    P.watchComments('task-a')
    publishComments([comment()])
    P.updateComment('comment-a', 'Optimistic edit')
    publishComments([comment('Saved edit')])
    expect(P.comments[0].body).toBe('Optimistic edit')
    resolve(null)
    await settle()
    expect(P.comments[0].body).toBe('Saved edit')
    expect(P.issues).toBe(tasks)
    expect(P.project(snapshot.projects[0].id)).toBe(project)
    expect(P.delayOf(tasks[0])).toBe(delay)
  })

  it('notifies thread observers and legacy subscribers without rerendering the workspace', async () => {
    const { P } = store
    const workspace = vi.fn()
    const detail = vi.fn()
    const sync = vi.fn()
    const legacy = vi.fn()
    P.updates.workspace.subscribe(workspace)
    P.updates.comments.subscribe(detail)
    P.updates.teamSync.subscribe(sync)
    P.subscribe(legacy)
    const version = P.updates.workspace.getSnapshot()
    P.watchComments('task-a')
    publishComments([comment()])
    P.updateComment('comment-a', 'Optimistic edit')
    expect(detail).toHaveBeenCalledTimes(3)
    publishComments([comment('Saved edit')])
    expect(detail).toHaveBeenCalledTimes(3)
    resolve(null)
    await settle()
    expect(P.comments[0].body).toBe('Saved edit')
    expect(detail).toHaveBeenCalledTimes(4)
    expect(legacy).toHaveBeenCalledTimes(4)
    expect(workspace).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
    expect(P.updates.workspace.getSnapshot()).toBe(version)
  })

  it('updates Team sync comment marks without invalidating the task thread or workspace', () => {
    const { P } = store
    const workspace = vi.fn()
    const detail = vi.fn()
    const sync = vi.fn()
    P.updates.workspace.subscribe(workspace)
    P.updates.comments.subscribe(detail)
    P.updates.teamSync.subscribe(sync)
    P.watchTeamSync(P.homeOrg)
    publishTeamSync([{ issue_id: 'task-a', at: '2026-10-04T12:00:00.000Z' }])
    expect(P.lastComments.get('task-a')).toBe(Date.parse('2026-10-04T12:00:00.000Z'))
    expect(P.lastCommentsLoaded).toBe(true)
    expect(sync).toHaveBeenCalledTimes(2)
    expect(workspace).not.toHaveBeenCalled()
    expect(detail).not.toHaveBeenCalled()
  })

  it('ignores an old subscription after the same task or Team sync page is reopened', () => {
    const { P } = store
    P.watchComments('task-a')
    const oldThread = publishComments
    P.watchComments(null)
    P.watchComments('task-a')
    publishComments([comment('Current thread')])
    oldThread([comment('Outdated thread')])
    expect(P.comments[0].body).toBe('Current thread')

    P.watchTeamSync(P.homeOrg)
    const oldSync = publishTeamSync
    P.watchTeamSync(null)
    P.watchTeamSync(P.homeOrg)
    publishTeamSync([{ issue_id: 'task-a', at: '2026-10-04T12:00:00.000Z' }])
    oldSync([{ issue_id: 'task-a', at: '2026-10-01T12:00:00.000Z' }])
    expect(P.lastComments.get('task-a')).toBe(Date.parse('2026-10-04T12:00:00.000Z'))
  })

  it('flushes a held workspace and comment delivery together to every affected observer', async () => {
    const { P } = store
    P.watchComments('task-a')
    publishComments([comment()])
    P.updateComment('comment-a', 'Optimistic edit')
    const workspace = vi.fn()
    const detail = vi.fn()
    P.updates.workspace.subscribe(workspace)
    P.updates.comments.subscribe(detail)
    snapshot.issues[0].title = 'Renamed remotely'
    publish(snapshot)
    publishComments([comment('Saved edit')])
    expect(workspace).not.toHaveBeenCalled()
    expect(detail).not.toHaveBeenCalled()
    resolve(null)
    await settle()
    expect(P.issues[0].title).toBe('Renamed remotely')
    expect(P.comments[0].body).toBe('Saved edit')
    expect(workspace).toHaveBeenCalledTimes(1)
    expect(detail).toHaveBeenCalledTimes(1)
  })

  it('restores the original comment after a refused optimistic edit without a new delivery', async () => {
    const { P } = store
    P.watchComments('task-a')
    publishComments([comment()])
    P.updateComment('comment-a', 'Refused edit')
    const workspace = vi.fn()
    const detail = vi.fn()
    P.updates.workspace.subscribe(workspace)
    P.updates.comments.subscribe(detail)
    reject(new ConvexError({ code: 'forbidden', message: 'Cannot edit this comment' }))
    await settle()
    expect(P.comments[0].body).toBe('Original')
    expect(workspace).toHaveBeenCalledTimes(1)
    expect(detail).toHaveBeenCalledTimes(1)
  })

  it('refreshes entity indexes when a snapshot changes or removes an entity', () => {
    const { P } = store
    const projectId = snapshot.projects[0].id
    expect(P.project(projectId)?.name).toBe(snapshot.projects[0].name)
    snapshot.projects[0].name = 'Renamed project'
    publish(structuredClone(snapshot))
    expect(P.project(projectId)?.name).toBe('Renamed project')
    snapshot.projects = []
    snapshot.issues = []
    publish(structuredClone(snapshot))
    expect(P.project(projectId)).toBeUndefined()
    expect(P.metaOf(projectId)).toBeNull()
  })
})
