import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { descriptionForm, printOf, trimmedForm } from '../../convex/lib/fieldPrints'
import type { FieldChange } from '../../convex/lib/functions'
import { plannerFixture as fixture, type Snapshot } from './plannerFixture.setup'

/* The field check in the app's store: every edit of an existing record
   sends the values on screen for the fields it changes as `expected`
   (convex/model/expected.ts), and a refusal over a field someone else
   changed shows a notice that stays until it is closed. */

type Planner = typeof import('./planner')['P']
type Pending = {
  name: string
  args: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

const network = vi.hoisted(() => ({
  mutation: vi.fn(),
  query: vi.fn(),
  onUpdate: vi.fn(),
}))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

const NOW = '2026-10-20T08:00:00.000Z'
const EMIL = 'p-emil'

describe('the field check in the store', () => {
  let P: Planner
  let snap: Snapshot
  let requests: Pending[]
  let showToast: ReturnType<typeof vi.fn>
  let sync: typeof import('../lib/syncStatus')
  let me: string

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    showToast = vi.fn()
    vi.stubGlobal('window', { showToast })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    snap = fixture()
    const org = snap.orgs[0].id
    me = snap.profiles[0].id
    snap.profiles.push({
      ...snap.profiles[0],
      id: EMIL,
      auth_user_id: undefined,
      name: 'Emil Berg',
    })
    const project = snap.projects[0].id
    const task = (id: string, num: number, over: Partial<Snapshot['issues'][number]> = {}) => ({
      id,
      org_id: org,
      project_id: project,
      num,
      title: `Task ${num}`,
      description: 'The old text',
      status: 'todo' as const,
      priority: 'medium' as const,
      paused: false,
      created_at: NOW,
      updated_at: NOW,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
      ...over,
    })
    snap.issues = [
      // a Wednesday start, off the Monday week grid, as REST may store it
      task('task-1', 1, {
        start_week: '2026-10-14',
        end_week: '2026-10-23',
        remaining_hours: 8,
        remaining_set_at: NOW,
      }),
      task('task-2', 2, { has_hidden_parent: true }),
      task('task-3', 3, { start_week: '2026-10-12', end_week: '2026-10-23' }),
    ]
    snap.links = [
      {
        id: 'link-1',
        source_id: 'task-1',
        target_id: 'task-3',
        type: 'blocks',
        pair_key: 'task-1:task-3',
        created_at: NOW,
      },
    ]
    requests = []
    network.query.mockResolvedValue(null)
    network.onUpdate.mockImplementation((ref, _args, next) => {
      if (getFunctionName(ref) === 'snapshot:commentThread')
        next({
          comments: [
            { id: 'c-1', issue_id: 'task-1', author: EMIL, body: 'First take', created_at: NOW },
          ],
          earlier: false,
          events: [],
        })
      else next(structuredClone(snap))
      return () => {}
    })
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      return new Promise((resolve, reject) => requests.push({ name, args, resolve, reject }))
    })
    const store = await import('./planner')
    sync = await import('../lib/syncStatus')
    P = store.P
    await store.initStore()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const key = (uuid: string) => P.handleOf(uuid) as string
  const latest = () => requests.at(-1) as Pending
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  const changed = (changes: Partial<FieldChange>[]) =>
    new ConvexError({
      code: 'conflict',
      reason: 'field_changed',
      message: 'status of QN-1 changed since you read it',
      changes: changes.map((c) => ({
        record: 'task',
        id: 'task-1',
        field: 'status',
        by: EMIL,
        at: NOW,
        ...c,
      })),
    })

  it('sends the value on screen before the paint, and a quick second edit the first one', () => {
    P.updateIssue(key('task-1'), { status: 'progress' })
    expect(latest().args).toMatchObject({
      patch: { status: 'progress' },
      expected: { status: 'todo' },
    })
    expect(P.issueById[key('task-1')].status).toBe('progress')
    P.updateIssue(key('task-1'), { status: 'review' })
    expect(latest().args.expected).toEqual({ status: 'progress' })
  })

  it('sends only the dates that differ from the screen, as sent', () => {
    const on = P.issueById[key('task-3')]
    // the start shown is on the grid: a new end goes out alone
    P.updateIssue(key('task-3'), { start: on.start, end: (on.end ?? 0) + 1 })
    expect(Object.keys(latest().args.patch as object)).toEqual(['end_week'])
    // an off-grid stored start goes with the new end, or the pair would differ
    const off = P.issueById[key('task-1')]
    P.updateIssue(key('task-1'), { start: off.start, end: (off.end ?? 0) + 1 })
    expect(Object.keys(latest().args.patch as object).sort()).toEqual(['end_week', 'start_week'])
    expect((latest().args.expected as Record<string, unknown>).start_week).toBe('2026-10-14')
  })

  it('paints hours rounded and sends nothing for hours that round to the stored ones', async () => {
    const sent = requests.length
    expect(await P.updateIssue(key('task-1'), { remaining: 8.01 })).toBe(true)
    expect(requests).toHaveLength(sent)
    P.updateIssue(key('task-1'), { remaining: 9.04 })
    expect(P.issueById[key('task-1')].remaining).toBe(9)
    expect(latest().args).toMatchObject({
      patch: { remaining_hours: 9 },
      expected: { remaining_hours: 8 },
    })
  })

  it('sends the hidden parent as the pair a read shows, and detaches from it', () => {
    P.updateIssue(key('task-2'), { parent: null })
    expect(latest().args).toMatchObject({
      patch: { parent_id: null },
      expected: { parent_id: null, has_hidden_parent: true },
    })
  })

  it('sends long texts as prints, from what an editor began with', async () => {
    P.updateIssue(
      key('task-1'),
      { title: 'A new title', description: 'My text' },
      { seen: { title: ' Seen title ', description: 'Seen text' } },
    )
    expect(latest().args.expected).toEqual({
      title: printOf(trimmedForm('Seen title')),
      description: printOf(descriptionForm('Seen text')),
    })
    P.watchComments('task-1')
    // the store takes a thread's first answer after a 0 ms timer
    await new Promise((resolve) => setTimeout(resolve, 0))
    await settle()
    void P.updateComment('c-1', 'Second take', { seen: 'First take', keepDraft: () => true })
    expect(latest()).toMatchObject({
      name: 'comments:update',
      args: { expected: { body: printOf('First take') } },
    })
  })

  it('says the change was discarded when the editor kept nothing', async () => {
    void P.updateIssue(key('task-1'), { description: 'My text' }, { keepDraft: () => false })
    latest().reject(changed([{ field: 'description' }]))
    await settle()
    expect(showToast.mock.calls.at(-1)?.[0]).toBe(
      'Not saved. Emil Berg changed the description of QN-1. Your change was discarded.',
    )
  })

  it('sends no expected with a change of teams alone, which is no field it compares', () => {
    P.updateUser(EMIL, { teams: [] })
    expect(latest()).toMatchObject({ name: 'profiles:update', args: { patch: { teams: [] } } })
    expect(latest().args).not.toHaveProperty('expected')
  })

  it('sends the link kind on screen with a removal', () => {
    P.removeLink(key('task-1'), key('task-3'))
    expect(latest()).toMatchObject({
      name: 'issues:removeLink',
      args: { a: 'task-1', b: 'task-3', expected: { kind: 'blocks' } },
    })
  })

  it('shows a notice that stays, naming who changed the field', async () => {
    void P.updateIssue(key('task-1'), { status: 'progress' })
    latest().reject(changed([{}]))
    await settle()
    expect(showToast).toHaveBeenCalledWith(
      'Not saved. Emil Berg changed the status of QN-1. Your change was discarded.',
      'error',
      expect.objectContaining({ sticky: true, key: 'field-changed-1' }),
    )
    expect(P.issueById[key('task-1')].status).toBe('todo')
  })

  it('adds later refusals to the open notice, and opens a new one once it is closed', async () => {
    void P.updateIssue(key('task-1'), { status: 'progress' })
    latest().reject(changed([{}]))
    await settle()
    void P.updateIssue(key('task-3'), { title: 'Other' })
    latest().reject(changed([{ id: 'task-3', field: 'title' }]))
    await settle()
    const [text, , opts] = showToast.mock.calls.at(-1) as [
      string,
      string,
      { key: string; onDismiss: () => void },
    ]
    expect(opts.key).toBe('field-changed-1')
    expect(text.split('\n')).toHaveLength(2)
    opts.onDismiss()
    void P.updateIssue(key('task-1'), { priority: 'high' })
    latest().reject(changed([{ field: 'priority' }]))
    await settle()
    expect(showToast.mock.calls.at(-1)?.[2]).toMatchObject({ key: 'field-changed-2' })
  })

  it('says You for a change made from another of the person’s seats or tabs', async () => {
    void P.updateIssue(key('task-1'), { status: 'progress' })
    latest().reject(changed([{ by: me }]))
    await settle()
    expect(showToast.mock.calls.at(-1)?.[0]).toBe(
      'Not saved. You changed the status of QN-1 elsewhere. This change was discarded.',
    )
  })

  it('joins an edit built on a refused one to that one’s line', async () => {
    void P.updateIssue(key('task-1'), { status: 'progress' })
    const first = latest()
    void P.updateIssue(key('task-1'), { status: 'review' })
    const second = latest()
    first.reject(changed([{}]))
    await settle()
    second.reject(changed([{}]))
    await settle()
    expect(showToast.mock.calls.at(-1)).toEqual([
      'Not saved. Emil Berg changed the status of QN-1. Your 2 changes were discarded.',
      'error',
      expect.objectContaining({ sticky: true, key: 'field-changed-1' }),
    ])
  })

  it('gives a later edit that kept its draft a line of its own', async () => {
    void P.updateIssue(key('task-1'), { title: 'First' })
    const first = latest()
    void P.updateIssue(key('task-1'), { title: 'Second' }, { keepDraft: () => true })
    const second = latest()
    first.reject(changed([{ field: 'title' }]))
    await settle()
    second.reject(changed([{ field: 'title' }]))
    await settle()
    expect(showToast.mock.calls.at(-1)?.[0]).toBe(
      'Not saved. Emil Berg changed the title of QN-1. Your change was discarded.\n' +
        'Not saved. Emil Berg changed the title of QN-1. Your text is still in the editor. Save again to replace their version.',
    )
  })

  it('says while you were offline for an edit that waited through a drop', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T09:00:00.000Z'))
    sync.syncStatus.setSocket({ connected: true, everConnected: true })
    void P.updateIssue(key('task-1'), { status: 'progress' })
    vi.setSystemTime(new Date('2026-10-20T09:00:10.000Z'))
    sync.syncStatus.setSocket({ connected: false, everConnected: true })
    vi.setSystemTime(new Date('2026-10-20T09:02:00.000Z'))
    sync.syncStatus.setSocket({ connected: true, everConnected: true })
    latest().reject(changed([{ at: '2026-10-20T09:01:00.000Z' }]))
    await settle()
    expect(showToast.mock.calls.at(-1)?.[0]).toBe(
      'Not saved. Emil Berg changed the status of QN-1 while you were offline. Your change was discarded.',
    )
  })

  it('runs keepDraft with the text on screen once the paint goes, and says it is kept', async () => {
    const kept: unknown[] = []
    void P.updateIssue(
      key('task-1'),
      { description: 'My text' },
      {
        keepDraft: (shown) => {
          kept.push(shown, P.issueById[key('task-1')].description)
          return true
        },
      },
    )
    latest().reject(changed([{ field: 'description' }]))
    await settle()
    expect(kept).toEqual(['The old text', 'The old text'])
    expect(showToast.mock.calls.at(-1)?.[0]).toBe(
      'Not saved. Emil Berg changed the description of QN-1. Your text is still in the editor. Save again to replace their version.',
    )
  })
})
