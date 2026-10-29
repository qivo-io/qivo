// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* P.fetchSearchPage, main Search's read, over a mocked network: what it
   asks search:page for, how it shapes the rows, and how it tells a refusal
   from a failure. */

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

describe('P.fetchSearchPage', () => {
  let store: typeof import('./planner')
  let snapshot: Snapshot

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    snapshot = plannerFixture()
    network.onUpdate.mockImplementation((ref, _args, receive) => {
      if (getFunctionName(ref) === 'workspace:whole') receive(structuredClone(snapshot))
      return vi.fn()
    })
    network.mutation.mockResolvedValue(null)
    store = await import('./planner')
    await store.initStore()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** The arguments of each search:page call. */
  const asked = () =>
    network.query.mock.calls
      .filter(([ref]) => getFunctionName(ref) === 'search:page')
      .map(([, args]) => args)
  const org = () => snapshot.orgs[0].id
  const place = { project: { id: 'firmware', name: 'Firmware' }, parent: null }
  const taskRow = (patch: Record<string, unknown> = {}) => ({
    kind: 'task',
    org_id: org(),
    id: 'task-uuid-12',
    num: 12,
    title: 'Flash the bootloader',
    status: 'todo',
    is_group: false,
    archived: false,
    ...place,
    ...patch,
  })

  it('asks for a page and gives each task its key and the handle the app opens it by', async () => {
    const project = {
      kind: 'project',
      org_id: org(),
      id: 'firmware',
      name: 'Firmware',
      parent: null,
    }
    network.query.mockResolvedValue({
      rows: [
        taskRow(),
        // a guest seat's task opens by its uuid, as its number may repeat a home one
        taskRow({ org_id: 'partner-org', id: 'partner-uuid-12', archived: true }),
        project,
      ],
      next_cursor: 's1~next',
      coverage: { complete: false, stopped: 'reads', searched: 1, of: 1 },
    })
    const answer = await store.P.fetchSearchPage('flash', {
      includeArchived: true,
      scope: { org_id: org(), project_id: 'firmware' },
      cursor: 's1~start',
    })
    expect(asked()).toEqual([
      {
        text: 'flash',
        include_archived: true,
        scope: { org_id: org(), project_id: 'firmware' },
        cursor: 's1~start',
      },
    ])
    expect(answer).toEqual({
      state: 'ok',
      rows: [
        { ...taskRow(), key: 'QN-12', handle: 'QN-12' },
        {
          ...taskRow({ org_id: 'partner-org', id: 'partner-uuid-12', archived: true }),
          key: 'QN-12',
          handle: 'partner-uuid-12',
        },
        project,
      ],
      nextCursor: 's1~next',
      coverage: { complete: false, stopped: 'reads', searched: 1, of: 1 },
    })
  })

  it('sends no scope or cursor for a first page of every organization', async () => {
    network.query.mockResolvedValue({ rows: [], next_cursor: null, coverage: { complete: true } })
    await store.P.fetchSearchPage('flash', { includeArchived: false, scope: null, cursor: null })
    expect(asked()).toEqual([{ text: 'flash', include_archived: false }])
  })

  it('tells a refused cursor and a refused text apart from a failed read', async () => {
    network.query.mockRejectedValueOnce(
      new ConvexError({
        code: 'bad_request',
        message: 'cursor must be the next_cursor of an earlier page',
      }),
    )
    expect(
      await store.P.fetchSearchPage('flash', { includeArchived: false, cursor: 'old' }),
    ).toEqual({
      state: 'refused',
      code: 'bad_request',
      message: 'Cursor must be the next_cursor of an earlier page.',
    })
    network.query.mockRejectedValueOnce(
      new ConvexError({ code: 'rule', message: 'a search must be at most 200 characters' }),
    )
    expect(await store.P.fetchSearchPage('flash', { includeArchived: false })).toEqual({
      state: 'refused',
      code: 'rule',
      message: 'A search must be at most 200 characters.',
    })
    // any other refusal, a transport error and an answer of another shape fail
    network.query.mockRejectedValueOnce(new ConvexError({ code: 'forbidden', message: 'no' }))
    expect(await store.P.fetchSearchPage('flash', { includeArchived: false })).toEqual({
      state: 'failed',
    })
    network.query.mockRejectedValueOnce(new Error('Too many index ranges read'))
    expect(await store.P.fetchSearchPage('flash', { includeArchived: false })).toEqual({
      state: 'failed',
    })
    network.query.mockResolvedValueOnce(null)
    expect(await store.P.fetchSearchPage('flash', { includeArchived: false })).toEqual({
      state: 'failed',
    })
  })
})
