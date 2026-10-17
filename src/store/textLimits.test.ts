import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEXT_MAX } from '../../convex/lib/textLimits'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'
import type { Row } from './rows'

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
const AT_CAP = 'a'.repeat(TEXT_MAX)
const OVER = 'a'.repeat(TEXT_MAX + 1)
const LEGACY = 'b'.repeat(25_000)

/* The store refuses text over the server's cap before it paints or sends,
 * so a refused draft is never replaced by a rollback. One task, saved before
 * the cap with a 25,000-character description, and its thread. */
describe('the text cap in the store', () => {
  let store: typeof import('./planner')
  let sent: string[]
  let toast: ReturnType<typeof vi.fn>
  let publishComments: (rows: Row<'comments'>[]) => void

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    toast = vi.fn()
    vi.stubGlobal('window', { showToast: toast })
    sent = []
    const snap: Snapshot = plannerFixture()
    snap.issues.push({
      id: 'task-a',
      org_id: snap.orgs[0].id,
      project_id: snap.projects[0].id,
      num: 1,
      title: 'Long brief',
      description: LEGACY,
      status: 'todo',
      priority: 'low',
      paused: false,
      created_at: NOW,
      updated_at: NOW,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    network.query.mockResolvedValue(null)
    network.mutation.mockImplementation((ref) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      sent.push(name)
      return new Promise(() => {})
    })
    network.onUpdate.mockImplementation((ref, _args, receive) => {
      if (getFunctionName(ref) === 'snapshot:forMe') receive(structuredClone(snap))
      else if (getFunctionName(ref) === 'snapshot:commentsForIssue') publishComments = receive
      return () => {}
    })
    store = await import('./planner')
    await store.initStore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const task = () => store.P.issues.find((it) => it.uuid === 'task-a')

  it('refuses a description over the cap before painting or sending', async () => {
    const { P, TEXT_TOO_LONG } = store
    const key = task()?.id ?? ''
    expect(await P.updateIssue(key, { description: OVER })).toBe(false)
    expect(toast).toHaveBeenCalledWith(TEXT_TOO_LONG.description, 'error')
    expect(task()?.description).toBe(LEGACY)
    expect(sent).toEqual([])
  })

  it('sends the stored legacy text back, and any text within the cap', () => {
    const { P } = store
    const key = task()?.id ?? ''
    void P.updateIssue(key, { title: 'Renamed', description: LEGACY })
    expect(task()?.title).toBe('Renamed')
    void P.updateIssue(key, { description: AT_CAP })
    expect(task()?.description).toBe(AT_CAP)
    expect(sent).toEqual(['issues:update', 'issues:update'])
    expect(toast).not.toHaveBeenCalled()
  })

  it('posts a comment of 20,000 characters after trimming and refuses one more', () => {
    const { P, TEXT_TOO_LONG } = store
    P.watchComments('task-a')
    publishComments([])
    expect(P.addComment('task-a', ` ${OVER} `)).toBeNull()
    expect(toast).toHaveBeenCalledWith(TEXT_TOO_LONG.comment, 'error')
    expect(P.comments).toEqual([])
    expect(sent).toEqual([])
    expect(P.addComment('task-a', `  ${AT_CAP}  `)).not.toBeNull()
    expect(P.comments.map((c) => c.body)).toEqual([AT_CAP])
    expect(sent).toEqual(['comments:create'])
  })

  it('leaves a comment unchanged when the edit is over the cap', () => {
    const { P, TEXT_TOO_LONG } = store
    P.watchComments('task-a')
    publishComments([
      {
        id: 'comment-a',
        issue_id: 'task-a',
        author: P.CURRENT_USER,
        body: 'Original',
        created_at: NOW,
      },
    ])
    P.updateComment('comment-a', OVER)
    expect(toast).toHaveBeenCalledWith(TEXT_TOO_LONG.comment, 'error')
    expect(P.comments.map((c) => c.body)).toEqual(['Original'])
    expect(sent).toEqual([])
    P.updateComment('comment-a', AT_CAP)
    expect(P.comments.map((c) => c.body)).toEqual([AT_CAP])
    expect(sent).toEqual(['comments:update'])
  })
})
