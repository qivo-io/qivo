import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture as fixture, type Snapshot } from './plannerFixture.setup'

type Planner = typeof import('./planner')['P']

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const NOW = '2026-09-14T08:00:00.000Z'

/* Awaited restores and uploads quote the server's refusal after a sentence of
   their own. The server's text is often a lowercase fragment, so the toast
   capitalizes it and ends it with one period. */
describe('refusal sentences in restore and upload toasts', () => {
  let P: Planner
  let snap: Snapshot
  let showToast: ReturnType<typeof vi.fn>
  // how the server answers each mutation by name; unlisted ones resolve null
  let answers: Record<string, () => Promise<unknown>>

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    showToast = vi.fn()
    vi.stubGlobal('window', { showToast })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    snap = fixture()
    snap.issues = [
      {
        id: 'task-1',
        org_id: snap.orgs[0].id,
        project_id: snap.projects[0].id,
        num: 1,
        title: 'Calibrate the sensor',
        description: '',
        status: 'todo',
        priority: 'low',
        paused: false,
        created_at: NOW,
        updated_at: NOW,
        has_hidden_subtasks: false,
        has_hidden_parent: false,
      },
    ]
    answers = {}
    network.query.mockResolvedValue(null)
    network.onUpdate.mockImplementation((_ref, _args, next) => {
      next(structuredClone(snap))
      return () => {}
    })
    network.mutation.mockImplementation((ref) => {
      const answer = answers[getFunctionName(ref)]
      return answer ? answer() : Promise.resolve(null)
    })
    const store = await import('./planner')
    P = store.P
    await store.initStore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const refuse = (code: string, message: string) => () =>
    Promise.reject(new ConvexError({ code, message }))
  const file = () => new File(['field notes'], 'notes.txt', { type: 'text/plain' })

  it('capitalizes a task restore refusal and ends it with a period', async () => {
    answers['issues:unarchive'] = refuse(
      'rule',
      'restoring this task would change a parent task in a project you cannot edit; an organization admin can restore it',
    )
    expect(await P.unarchiveIssue('task-archived', 'Old task', snap.projects[0].id)).toBe(false)
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      "Couldn't restore. Restoring this task would change a parent task in a project you cannot edit; an organization admin can restore it.",
      'error',
    )
  })

  it('tells, as a notice, that a restored subtask left a full parent', async () => {
    answers['issues:unarchive'] = () =>
      Promise.resolve({ issue: { id: 'task-archived' }, left_parent: true })
    expect(await P.unarchiveIssue('task-archived', 'Old task', snap.projects[0].id)).toBe(true)
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      '"Old task" is back as a top-level task, because its parent already has 100 active subtasks.',
      'info',
    )
  })

  it('says nothing more when a restored task kept its parent', async () => {
    answers['issues:unarchive'] = () =>
      Promise.resolve({ issue: { id: 'task-archived' }, left_parent: false })
    expect(await P.unarchiveIssue('task-archived', 'Old task', snap.projects[0].id)).toBe(true)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('adds no second period to a project restore refusal that has one', async () => {
    answers['projects:unarchive'] = refuse('rule', 'Ask a project lead to restore it.')
    expect(await P.unarchiveProject(snap.projects[0].id)).toBe(false)
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      "Couldn't restore. Ask a project lead to restore it.",
      'error',
    )
  })

  it('names the file and the reason when the server refuses an upload', async () => {
    answers['files:uploadUrl'] = refuse('forbidden', 'no write access to this project')
    expect(await P.addAttachment('task-1', file())).toBeNull()
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      'Couldn\'t upload "notes.txt". No write access to this project.',
      'error',
    )
  })

  it('quotes the size refusal that attach returns as a sentence', async () => {
    answers['files:uploadUrl'] = () => Promise.resolve('https://upload.example.test/u')
    answers['files:attach'] = () =>
      Promise.resolve({
        refused: {
          code: 'bad_request',
          message: 'attachment exceeds the organization limit of 1 MiB',
        },
      })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ storageId: 'storage-1' })),
    )
    expect(await P.addAttachment('task-1', file())).toBeNull()
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      'Couldn\'t upload "notes.txt". Attachment exceeds the organization limit of 1 MiB.',
      'error',
    )
  })
})
