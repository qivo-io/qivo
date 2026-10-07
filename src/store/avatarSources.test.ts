import { type FunctionReturnType, getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'

type Snapshot = NonNullable<FunctionReturnType<typeof api.snapshot.forMe>>
type Minted = FunctionReturnType<typeof api.files.mintUrls>
const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'portrait-account' } } }),
  },
  signOut: vi.fn(),
}))

const NOW = new Date('2026-09-14T08:00:00.000Z')
function fixture(): Snapshot {
  const org = {
    id: crypto.randomUUID(),
    name: 'Testbed Labs',
    slug: 'testbed-labs',
    created_at: NOW.toISOString(),
    next_issue_num: 1,
    next_project_num: 1,
    date_format: 'iso' as const,
    week_start: 1 as const,
    week_one_rule: 'first4day' as const,
    default_plannable_hours: 40,
    gravatar_avatars: false,
  }
  const profiles: Snapshot['profiles'] = ['One', 'Two'].map((name, index) => ({
    id: crypto.randomUUID(),
    org_id: org.id,
    auth_user_id: index ? 'other-account' : 'portrait-account',
    name,
    initials: name[0],
    color: '#335577',
    org_role: 'admin',
    active: true,
    kind: 'person',
    created_at: NOW.toISOString(),
    avatar_storage_id: `storage-${index}` as Id<'_storage'>,
  }))
  return {
    auth_user_id: 'portrait-account',
    myProfileIds: [profiles[0].id],
    orgs: [org],
    profiles,
    projects: [],
    issues: [],
    teams: [],
    teamMembers: [],
    access: [],
    teamAccess: [],
    links: [],
    milestones: [],
    activity: [],
    labels: [],
    issueLabels: [],
    issueSubs: [],
    attachments: [],
    orgLoad: [],
    messages: [],
    readMessageCount: 0,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('uploaded profile pictures through the planner store', () => {
  let store: typeof import('./planner')
  let snap: Snapshot
  let publish: (value: Snapshot) => void
  let mint: ReturnType<typeof vi.fn<() => Promise<Minted>>>
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>
  let decode: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>
  let revoke: ReturnType<typeof vi.spyOn>

  const response = (): Minted => ({
    attachments: {},
    avatars: Object.fromEntries(
      snap.profiles
        .filter((profile) => profile.avatar_storage_id)
        .map((profile) => [
          profile.id,
          {
            url: `https://files.test/avatars/${profile.id}?v=${profile.avatar_storage_id}&e=${Date.now()}`,
            exp: Math.floor(Date.now() / 1000) + 600,
          },
        ]),
    ),
  })
  const ready = async () =>
    vi.waitFor(() =>
      expect(store.P.users.every((user) => user.avatarUrl?.startsWith('blob:'))).toBe(true),
    )

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    vi.stubGlobal('window', { clearTimeout, setTimeout })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new Blob(['face'])))
    vi.stubGlobal('fetch', fetcher)
    decode = vi.fn<(url: string) => Promise<void>>().mockResolvedValue()
    vi.stubGlobal(
      'Image',
      class {
        src = ''
        naturalWidth = 256
        naturalHeight = 256
        decode() {
          return decode(this.src)
        }
      },
    )
    let serial = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:portrait-${++serial}`)
    revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    snap = fixture()
    mint = vi.fn<() => Promise<Minted>>().mockImplementation(async () => response())
    network.query.mockImplementation((ref) =>
      getFunctionName(ref) === 'files:mintUrls' ? mint() : Promise.resolve(null),
    )
    network.mutation.mockResolvedValue(null)
    network.onUpdate.mockImplementation((_ref, _args, next) => {
      publish = next
      next(structuredClone(snap))
      return () => {}
    })
    store = await import('./planner')
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('publishes ready portraits without waiting for another portrait to decode', async () => {
    const slow = deferred<void>()
    decode.mockReturnValueOnce(slow.promise)
    await store.initStore()
    await vi.waitFor(() => expect(store.P.users.filter((user) => user.avatarUrl)).toHaveLength(1))
    expect(store.P.users[0].avatarUrl).toBeNull()
    slow.resolve()
    await ready()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('retains shared prepared sources on a rebuild during delayed and successful renewal', async () => {
    await store.initStore()
    await ready()
    const sources = store.P.users.map((user) => user.avatarUrl)
    const renewal = deferred<Minted>()
    mint.mockReturnValueOnce(renewal.promise)
    vi.setSystemTime(new Date(NOW.getTime() + 480_000))
    publish(structuredClone(snap))
    expect(store.P.users.map((user) => user.avatarUrl)).toEqual(sources)
    expect(mint).toHaveBeenCalledTimes(2)
    publish(structuredClone(snap))
    expect(mint).toHaveBeenCalledTimes(2)
    renewal.resolve(response())
    await vi.advanceTimersByTimeAsync(0)
    publish(structuredClone(snap))
    expect(store.P.users.map((user) => user.avatarUrl)).toEqual(sources)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(revoke).not.toHaveBeenCalled()
  })

  it.each(['omission', 'refusal'])(
    'drops prepared portraits immediately on mint %s',
    async (kind) => {
      await store.initStore()
      await ready()
      if (kind === 'omission') mint.mockResolvedValueOnce({ avatars: {}, attachments: {} })
      else
        mint.mockRejectedValueOnce(
          new ConvexError({ code: 'forbidden', message: 'No longer a member' }),
        )
      vi.setSystemTime(new Date(NOW.getTime() + 480_000))
      publish(structuredClone(snap))
      await vi.waitFor(() => expect(store.P.users.every((user) => !user.avatarUrl)).toBe(true))
      expect(revoke).toHaveBeenCalledTimes(2)
      expect(mint).toHaveBeenCalledTimes(2)
    },
  )

  it('releases a stuck mint and retries without losing the ready source or re-downloading bytes', async () => {
    await store.initStore()
    await ready()
    const sources = store.P.users.map((user) => user.avatarUrl)
    const stalled = deferred<Minted>()
    mint.mockReturnValueOnce(stalled.promise)
    vi.setSystemTime(new Date(NOW.getTime() + 480_000))
    publish(structuredClone(snap))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(store.P.users.map((user) => user.avatarUrl)).toEqual(sources)
    await vi.advanceTimersByTimeAsync(45_000)
    expect(mint).toHaveBeenCalledTimes(3)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(store.P.users.map((user) => user.avatarUrl)).toEqual(sources)
    stalled.resolve({ avatars: {}, attachments: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.P.users.map((user) => user.avatarUrl)).toEqual(sources)
  })

  it('fences an old mint when a storage version changes before the response arrives', async () => {
    const pending = deferred<Minted>()
    mint.mockReturnValueOnce(pending.promise)
    await store.initStore()
    const obsolete = response()
    snap.profiles[0].avatar_storage_id = 'new-storage' as Id<'_storage'>
    publish(structuredClone(snap))
    await vi.waitFor(() => expect(store.P.users[0].avatarUrl).toBe('blob:portrait-1'))
    pending.resolve(obsolete)
    await ready()
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('v=storage-0&'))).toBe(false)
    expect(store.P.users[0].avatarUrl).toBe('blob:portrait-1')
  })

  it('revokes removed versions and clears prepared sources before authentication reinitializes', async () => {
    await store.initStore()
    await ready()
    const removed = store.P.users[0].avatarUrl
    snap.profiles[0].avatar_storage_id = undefined
    publish(structuredClone(snap))
    expect(store.P.users[0].avatarUrl).toBeNull()
    expect(revoke).toHaveBeenCalledWith(removed)
    const remaining = store.P.users[1].avatarUrl
    const pending = deferred<Minted>()
    mint.mockReturnValueOnce(pending.promise)
    await store.initStore()
    expect(revoke).toHaveBeenCalledWith(remaining)
    expect(store.P.users.every((user) => user.avatarUrl === null)).toBe(true)
    pending.resolve(response())
    await vi.waitFor(() => expect(store.P.users[1].avatarUrl).toMatch(/^blob:/))
    expect(store.P.users[1].avatarUrl).not.toBe(remaining)
  })
})
