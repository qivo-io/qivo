import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../../convex/lib/limits'
import { plannerFixture as fixture, type Snapshot } from './plannerFixture.setup'

type Planner = typeof import('./planner')['P']

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('./guard/liveDouble.setup')).liveOver(network),
}))
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
      Promise.resolve({ issue: { id: 'task-archived' }, left_parent: 'full' })
    expect(await P.unarchiveIssue('task-archived', 'Old task', snap.projects[0].id)).toBe(true)
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      '"Old task" is back as a top-level task, because its parent already has 100 active subtasks.',
      'info',
    )
  })

  it('tells, as a notice, that a restored subtask left a parent deleted since', async () => {
    answers['issues:unarchive'] = () =>
      Promise.resolve({ issue: { id: 'task-archived' }, left_parent: 'deleted' })
    expect(await P.unarchiveIssue('task-archived', 'Old task', snap.projects[0].id)).toBe(true)
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      '"Old task" is back as a top-level task, because its parent was deleted after this task was archived.',
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

  /* The arguments the store sent `name` with, by its last call. */
  const sentWith = (name: string) =>
    network.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === name).at(-1)?.[1]
  /* An upload URL's receiver that refuses the POST with `error`. */
  const receiverRefuses = (error: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error }, { status: 400 })),
    )
  const LOST =
    'The upload did not finish. Check your connection and try again, or send a smaller file.'
  const BUDGET =
    'the demo stores at most 5 MiB of files in total, and 0.4 MiB of it is free. Remove a file, a picture or your background, or delete items for good in Settings → Projects → Deleted items, then try again.'

  it("quotes the demo budget's and the upload cap's sentences in full, capitalized, naming the file", async () => {
    for (const message of [BUDGET, LIMITS.uploadsInProgress.refusal]) {
      showToast.mockClear()
      answers['files:uploadUrl'] = refuse('rule', message)
      expect(await P.addAttachment('task-1', file())).toBeNull()
      expect(showToast).toHaveBeenCalledExactlyOnceWith(
        `Couldn't upload "notes.txt". ${message.charAt(0).toUpperCase()}${message.slice(1)}`,
        'error',
      )
    }
  })

  it('declares the size and name of the file it sends, and quotes the sentence its upload URL refused', async () => {
    answers['files:uploadUrl'] = () => Promise.resolve('https://upload.example.test/u')
    receiverRefuses('the file is larger than the most this upload URL takes; start a new upload')
    expect(await P.addAttachment('task-1', file())).toBeNull()
    expect(sentWith('files:uploadUrl')).toMatchObject({ size: 11, name: 'notes.txt' })
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      'Couldn\'t upload "notes.txt". The file is larger than the most this upload URL takes; start a new upload.',
      'error',
    )
  })

  it('says the upload did not finish when its POST ends without the receiver’s answer', async () => {
    answers['files:uploadUrl'] = () => Promise.resolve('https://upload.example.test/u')
    answers['files:avatarUploadUrl'] = () => Promise.resolve('https://upload.example.test/a')
    const picture = new File(['png bytes'], 'me.png', { type: 'image/png' })
    // the connection drops, and the hosting front end answers instead
    for (const post of [
      async () => {
        throw new TypeError('Failed to fetch')
      },
      async () => new Response('Bad gateway', { status: 502 }),
    ]) {
      showToast.mockClear()
      vi.stubGlobal('fetch', vi.fn(post))
      expect(await P.addAttachment('task-1', file())).toBeNull()
      expect(showToast).toHaveBeenCalledExactlyOnceWith(
        `Couldn't upload "notes.txt". ${LOST}`,
        'error',
      )
      expect(await P.setAvatar(snap.profiles[0].id, picture)).toBe(LOST)
    }
  })

  it('declares a picture’s size and answers the sentence its upload URL refused', async () => {
    answers['files:avatarUploadUrl'] = () => Promise.resolve('https://upload.example.test/a')
    receiverRefuses(BUDGET)
    const picture = new File(['png bytes'], 'me.png', { type: 'image/png' })
    const profile = snap.profiles[0].id
    expect(await P.setAvatar(profile, picture)).toBe(
      `${BUDGET.charAt(0).toUpperCase()}${BUDGET.slice(1)}`,
    )
    expect(sentWith('files:avatarUploadUrl')).toEqual({ profile_id: profile, size: 9 })
  })

  it('declares a background’s size, and cancels its ticket when the receiver refuses it', async () => {
    answers['appearance:createUpload'] = () =>
      Promise.resolve({
        ticket_id: 'ticket-1',
        upload_url: 'https://upload.example.test/b',
        expires_at: 0,
      })
    receiverRefuses({
      code: 'bad_request',
      message: 'The file is larger than its upload said. Choose it again.',
    })
    const image = new File(['jpeg bytes'], 'Lake.jpg', { type: 'image/jpeg' })
    await expect(P.uploadAppearanceImage(image, new AbortController().signal)).rejects.toThrow(
      'The file is larger than its upload said. Choose it again.',
    )
    expect(sentWith('appearance:createUpload')).toEqual({ name: 'Lake.jpg', size: 10 })
    expect(sentWith('appearance:cancelUpload')).toEqual({ ticket_id: 'ticket-1' })
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
