import { type FunctionReturnType, getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import type { PersonFaceRow } from '../../convex/model/peopleSettings'
import type { Whole } from './guard/liveDouble.setup'
import { peopleSettingsStandIn } from './peopleSettingsStandIn.setup'
import type { PersonView } from './viewModels'

type Snapshot = Whole
type Minted = FunctionReturnType<typeof api.files.mintUrls>
const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('./guard/liveDouble.setup')).liveOver(network),
}))
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
  }
  const profiles: Snapshot['profiles'] = ['One', 'Two'].map((name, index) => ({
    id: crypto.randomUUID(),
    org_id: org.id,
    auth_user_id: `${name.toLowerCase()}-account`,
    name,
    initials: name[0],
    color: '#335577',
    org_role: 'admin',
    active: true,
    kind: 'person',
    // one after the other, so One comes first
    created_at: new Date(NOW.getTime() + index).toISOString(),
    avatar_storage_id: `storage-${index}` as Id<'_storage'>,
  }))
  // the caller, last and without an uploaded picture: the store asks for
  // the caller's own pictures whatever the views name, so the cases of
  // One's and Two's pictures see only what their views name
  const me: Snapshot['profiles'][number] = {
    id: crypto.randomUUID(),
    org_id: org.id,
    auth_user_id: 'portrait-account',
    name: 'Me',
    initials: 'M',
    color: '#335577',
    org_role: 'admin',
    active: true,
    kind: 'person',
    created_at: new Date(NOW.getTime() + 2).toISOString(),
  }
  profiles.push(me)
  return {
    auth_user_id: 'portrait-account',
    myProfileIds: [me.id],
    orgs: [org],
    profiles,
    projects: [],
    issues: [],
    teams: [],
    teamMembers: [],
    access: [],
    teamAccess: [],
    links: [],
    labels: [],
    issueLabels: [],
    issueSubs: [],
    attachments: [],
    orgLoad: [],
    messages: [],
    delivered_at: '2026-09-15T08:00:00.000Z',
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

/* The store holds nobody but the signed-in person, so everyone else's
   picture comes with their face from the profile cache: a view names
   them (P.namePeople), people:byIds answers from the server's data
   (store/peopleSettingsStandIn.setup.ts) and answers again when it
   changes, and the store mints and downloads what the faces name. */
describe('uploaded profile pictures through the planner store', () => {
  let store: typeof import('./planner')
  let snap: Snapshot
  let publish: (value: Snapshot) => void
  let mint: ReturnType<typeof vi.fn<() => Promise<Minted>>>
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>
  let decode: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>
  let revoke: ReturnType<typeof vi.spyOn>

  // the people.byIds rows of people the workspace does not hold
  // faces people:byIds answers beside the server's profiles, for a person
  // the published data does not hold
  let faces: PersonFaceRow[] = []
  // the open people:byIds reads, answered again on each delivery
  let byIdsReads: { args: { org_id: string; ids: string[] }; next: (value: unknown) => void }[] = []
  const facesOf = (args: { org_id: string; ids: string[] }) => {
    const held = peopleSettingsStandIn(snap, 'people:byIds', args) as { rows: PersonFaceRow[] }
    return { rows: [...held.rows, ...faces.filter((face) => args.ids.includes(face.id))] }
  }
  /* What the store shows of every person but the caller, and their
     pictures, null while a face has not arrived. */
  const others = (): (PersonView | null)[] =>
    snap.profiles
      .filter((profile) => !snap.myProfileIds.includes(profile.id))
      .map((profile) => store.P.person(profile.id))
  const pictureOf = (person: PersonView | null) => (person?.state === 'ok' ? person.picture : null)
  const pictures = () => others().map(pictureOf)
  const response = (): Minted => ({
    attachments: {},
    avatars: Object.fromEntries(
      [
        ...snap.profiles.map((p) => ({ id: p.id, version: p.avatar_storage_id })),
        ...faces.map((face) => ({ id: face.id, version: face.avatar ?? undefined })),
      ]
        .filter((profile) => profile.version)
        .map((profile) => [
          profile.id,
          {
            url: `https://files.test/avatars/${profile.id}?v=${profile.version}&e=${Date.now()}`,
            exp: Math.floor(Date.now() / 1000) + 600,
          },
        ]),
    ),
  })
  /* A delivery that changes the workspace, so the store rebuilds, and
     answers the open face reads again. Convex re-sends no part whose
     answer stayed the same. */
  let deliveries = 0
  const deliverChange = () => {
    snap.orgs[0].name = `Testbed ${++deliveries}`
    publish(structuredClone(snap))
    for (const read of byIdsReads) read.next(facesOf(read.args))
  }
  /* An open view that shows every person of the workspace, so the store
     asks for each one's picture, as a page that lists them all does. */
  const nameAll = () =>
    store.P.namePeople(
      'every-person',
      snap.profiles.map((profile) => ({ org: profile.org_id, id: profile.id })),
    )
  /* Waits until every other person with an uploaded picture shows it. */
  const ready = async () =>
    vi.waitFor(() =>
      expect(
        snap.profiles
          .filter((profile) => profile.avatar_storage_id && !snap.myProfileIds.includes(profile.id))
          .every((profile) => pictureOf(store.P.person(profile.id))?.startsWith('blob:')),
      ).toBe(true),
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
    faces = []
    byIdsReads = []
    network.onUpdate.mockImplementation((ref, args: { org_id: string; ids: string[] }, next) => {
      // people.byIds answers the faces of the people the store does not
      // hold, as the server would
      if (getFunctionName(ref) === 'people:byIds') {
        const read = { args, next }
        byIdsReads.push(read)
        next(facesOf(args))
        return () => {
          byIdsReads = byIdsReads.filter((open) => open !== read)
        }
      }
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
    nameAll()
    await vi.waitFor(() => expect(pictures().filter(Boolean)).toHaveLength(1))
    expect(pictures()[0]).toBeNull()
    slow.resolve()
    await ready()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('retains shared prepared sources on a rebuild during delayed and successful renewal', async () => {
    await store.initStore()
    nameAll()
    await ready()
    const sources = pictures()
    const renewal = deferred<Minted>()
    mint.mockReturnValueOnce(renewal.promise)
    vi.setSystemTime(new Date(NOW.getTime() + 480_000))
    deliverChange()
    expect(pictures()).toEqual(sources)
    // the mint queue sends what one task asked for after it
    await vi.advanceTimersByTimeAsync(0)
    expect(mint).toHaveBeenCalledTimes(2)
    deliverChange()
    await vi.advanceTimersByTimeAsync(0)
    expect(mint).toHaveBeenCalledTimes(2)
    renewal.resolve(response())
    await vi.advanceTimersByTimeAsync(0)
    deliverChange()
    expect(pictures()).toEqual(sources)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(revoke).not.toHaveBeenCalled()
  })

  it.each(['omission', 'refusal'])(
    'drops prepared portraits immediately on mint %s',
    async (kind) => {
      await store.initStore()
      nameAll()
      await ready()
      if (kind === 'omission') mint.mockResolvedValueOnce({ avatars: {}, attachments: {} })
      else
        mint.mockRejectedValueOnce(
          new ConvexError({ code: 'forbidden', message: 'No longer a member' }),
        )
      vi.setSystemTime(new Date(NOW.getTime() + 480_000))
      deliverChange()
      await vi.waitFor(() => expect(pictures().every((picture) => !picture)).toBe(true))
      expect(revoke).toHaveBeenCalledTimes(2)
      expect(mint).toHaveBeenCalledTimes(2)
    },
  )

  it('releases a stuck mint and retries without losing the ready source or re-downloading bytes', async () => {
    await store.initStore()
    nameAll()
    await ready()
    const sources = pictures()
    const stalled = deferred<Minted>()
    mint.mockReturnValueOnce(stalled.promise)
    vi.setSystemTime(new Date(NOW.getTime() + 480_000))
    deliverChange()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(pictures()).toEqual(sources)
    await vi.advanceTimersByTimeAsync(45_000)
    expect(mint).toHaveBeenCalledTimes(3)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(pictures()).toEqual(sources)
    stalled.resolve({ avatars: {}, attachments: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(pictures()).toEqual(sources)
  })

  it('mints 1,000 pictures in calls of 100 and repaints the store at most once a frame', async () => {
    const base = snap.profiles[0] as Snapshot['profiles'][number]
    snap.profiles = Array.from({ length: 1000 }, (_, i) => ({
      ...base,
      id: i === 0 ? base.id : crypto.randomUUID(),
      auth_user_id: i === 0 ? 'portrait-account' : `account-${i}`,
      name: `Person ${i}`,
      created_at: new Date(NOW.getTime() + i).toISOString(),
      avatar_storage_id: `storage-${i}` as Id<'_storage'>,
    }))
    // the caller is the first of them, with a picture of their own
    snap.myProfileIds = [base.id]
    const asked: number[] = []
    network.query.mockImplementation((ref, args: { profile_ids?: string[] }) => {
      if (getFunctionName(ref) !== 'files:mintUrls') return Promise.resolve(null)
      asked.push(args.profile_ids?.length ?? 0)
      return mint()
    })
    let emits = 0
    const stop = store.P.subscribe(() => {
      emits++
    })
    await store.initStore()
    nameAll()
    const start = Date.now()
    const before = emits
    await vi.waitFor(
      () =>
        expect(
          [...pictures(), pictureOf(store.P.person(base.id))].every((picture) =>
            picture?.startsWith('blob:'),
          ),
        ).toBe(true),
      { timeout: 30_000 },
    )
    const frames = Math.ceil((Date.now() - start) / 16) + 1
    stop()
    // the caller's own picture at boot, then the 999 others in calls of 100
    expect(asked).toEqual([1, ...Array(9).fill(100), 99])
    expect(fetcher).toHaveBeenCalledTimes(1000)
    // a thousand ready pictures, one repaint a frame at most, far fewer
    // than one a picture
    expect(emits - before).toBeLessThanOrEqual(frames)
    expect(emits - before).toBeLessThan(500)
  })

  it('renews, downloads and releases no picture while the page is hidden, and renews without downloading on return', async () => {
    const page = { visibilityState: 'visible', listeners: new Set<() => void>() }
    vi.stubGlobal('document', {
      get visibilityState() {
        return page.visibilityState
      },
      addEventListener: (_: string, listener: () => void) => page.listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => page.listeners.delete(listener),
    })
    const turn = (state: 'visible' | 'hidden') => {
      page.visibilityState = state
      for (const listener of page.listeners) listener()
    }
    await store.initStore()
    nameAll()
    await ready()
    const sources = pictures()
    turn('hidden')
    // an hour hidden, with the sweep's ticks and a delivery that rebuilds
    vi.setSystemTime(new Date(NOW.getTime() + 3_600_000))
    await vi.advanceTimersByTimeAsync(120_000)
    deliverChange()
    await vi.advanceTimersByTimeAsync(0)
    expect(mint).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(pictures()).toEqual(sources)
    turn('visible')
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(20)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(pictures()).toEqual(sources)
    // a refusal at a later renewal still releases them
    mint.mockRejectedValueOnce(
      new ConvexError({ code: 'forbidden', message: 'No longer a member' }),
    )
    vi.setSystemTime(new Date(Date.now() + 480_000))
    deliverChange()
    await vi.waitFor(() => expect(pictures().every((picture) => !picture)).toBe(true))
  })

  it('fences an old mint when a storage version changes before the response arrives', async () => {
    // the signed-in person's own picture, which the root part sends and the
    // store mints at boot, with no view naming anyone
    const mine = snap.profiles.find((p) => snap.myProfileIds.includes(p.id))
    if (!mine) throw new Error('no own profile')
    mine.avatar_storage_id = 'storage-mine' as Id<'_storage'>
    const pending = deferred<Minted>()
    mint.mockReturnValueOnce(pending.promise)
    await store.initStore()
    await vi.advanceTimersByTimeAsync(0)
    expect(mint).toHaveBeenCalledOnce()
    const obsolete = response()
    mine.avatar_storage_id = 'new-storage' as Id<'_storage'>
    deliverChange()
    await vi.waitFor(() => expect(pictureOf(store.P.person(mine.id))).toBe('blob:portrait-1'))
    pending.resolve(obsolete)
    await vi.advanceTimersByTimeAsync(20)
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('v=storage-mine&'))).toBe(false)
    expect(pictureOf(store.P.person(mine.id))).toBe('blob:portrait-1')
  })

  it('mints and downloads only the pictures an open view names, and stops when it closes', async () => {
    await store.initStore()
    await vi.advanceTimersByTimeAsync(20)
    // no view names anyone: nothing is asked
    expect(mint).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    const [one, two] = snap.profiles as [Snapshot['profiles'][number], Snapshot['profiles'][number]]
    const asked: string[][] = []
    network.query.mockImplementation((ref, args: { profile_ids?: string[] }) => {
      if (getFunctionName(ref) !== 'files:mintUrls') return Promise.resolve(null)
      asked.push(args.profile_ids ?? [])
      return mint()
    })
    store.P.namePeople('page', [{ org: two.org_id, id: two.id }])
    await vi.waitFor(() =>
      expect(store.P.person(two.id)).toMatchObject({ picture: expect.stringMatching(/^blob:/) }),
    )
    expect(asked).toEqual([[two.id]])
    expect(fetcher).toHaveBeenCalledOnce()
    // the store knows nothing of One, whom no view names, and asks nothing
    expect(store.P.person(one.id)).toMatchObject({ state: 'loading' })
    // the page closes: its picture is not renewed
    store.P.namePeople('page', [])
    vi.setSystemTime(new Date(NOW.getTime() + 480_000))
    deliverChange()
    await vi.advanceTimersByTimeAsync(31_000)
    expect(asked).toEqual([[two.id]])
  })

  it('mints no queued picture of a closed page once a call slot frees, but one another view still names', async () => {
    const { MINT_QUEUE } = await import('../lib/mintQueue')
    const bounds = { ...MINT_QUEUE }
    // calls of two, so seven pictures fill the two call slots and wait
    MINT_QUEUE.batch = 2
    try {
      const base = snap.profiles[0] as Snapshot['profiles'][number]
      for (let i = 0; i < 5; i++)
        snap.profiles.push({
          ...base,
          id: crypto.randomUUID(),
          auth_user_id: `extra-${i}-account`,
          name: `Extra ${i}`,
          created_at: new Date(NOW.getTime() + 10 + i).toISOString(),
          avatar_storage_id: `storage-extra-${i}` as Id<'_storage'>,
        })
      const calls: { ids: string[]; answer: ReturnType<typeof deferred<Minted>> }[] = []
      network.query.mockImplementation((ref, args: { profile_ids?: string[] }) => {
        if (getFunctionName(ref) !== 'files:mintUrls') return Promise.resolve(null)
        const answer = deferred<Minted>()
        calls.push({ ids: args.profile_ids ?? [], answer })
        return answer.promise
      })
      await store.initStore()
      const pictured = snap.profiles.filter((p) => p.avatar_storage_id)
      expect(pictured).toHaveLength(7)
      const ids = pictured.map((p) => p.id)
      const named = (list: typeof pictured) => list.map((p) => ({ org: p.org_id, id: p.id }))
      // the page names all seven, and then another view the page's last
      // person
      store.P.namePeople('page', named(pictured))
      // the faces arrive, and the store takes them once a frame
      await vi.advanceTimersByTimeAsync(20)
      store.P.namePeople('other', named(pictured.slice(6)))
      await vi.advanceTimersByTimeAsync(20)
      expect(calls.map((c) => c.ids)).toEqual([ids.slice(0, 2), ids.slice(2, 4)])
      // the page closes while three of its pictures wait for a call
      store.P.namePeople('page', [])
      calls[0]?.answer.resolve(response())
      await vi.advanceTimersByTimeAsync(0)
      expect(calls.map((c) => c.ids)).toEqual([ids.slice(0, 2), ids.slice(2, 4), ids.slice(6)])
      calls[1]?.answer.resolve(response())
      calls[2]?.answer.resolve(response())
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toHaveLength(3)
      // the dropped ones count as no failure, so named again they mint at
      // once, with no retry delay, beside the ones whose leases came while
      // the page was closed
      store.P.namePeople('page', named(pictured))
      await vi.advanceTimersByTimeAsync(20)
      for (let answered = 3; answered < calls.length; answered++) {
        calls[answered]?.answer.resolve(response())
        await vi.advanceTimersByTimeAsync(0)
      }
      expect(calls.slice(3).flatMap((c) => c.ids)).toEqual(expect.arrayContaining(ids.slice(4, 6)))
    } finally {
      Object.assign(MINT_QUEUE, bounds)
    }
  })

  it('mints the caller’s own new picture with no view naming anyone, as Settings › Account shows it', async () => {
    await store.initStore()
    await vi.advanceTimersByTimeAsync(20)
    const me = snap.myProfileIds[0] ?? ''
    expect(mint).not.toHaveBeenCalled()
    const asked: string[][] = []
    network.query.mockImplementation((ref, args: { profile_ids?: string[] }) => {
      if (getFunctionName(ref) !== 'files:mintUrls') return Promise.resolve(null)
      asked.push(args.profile_ids ?? [])
      return mint()
    })
    // the upload: an address, the POST that stores the bytes, and the write
    // that hangs them on the profile, which the server then holds
    network.mutation.mockImplementation(async (ref) => {
      const name = getFunctionName(ref)
      if (name === 'files:avatarUploadUrl') return 'https://files.test/upload'
      if (name === 'files:setAvatar') {
        const mine = snap.profiles.find((profile) => profile.id === me)
        if (mine) mine.avatar_storage_id = 'storage-mine' as Id<'_storage'>
      }
      return null
    })
    fetcher.mockImplementation(async (_url, init) =>
      init?.method === 'POST'
        ? Response.json({ storageId: 'storage-mine' })
        : new Response(new Blob(['face'])),
    )
    const file = new File([new Uint8Array(64)], 'me.png', { type: 'image/png' })
    await expect(store.P.setAvatar(me, file, null)).resolves.toBeNull()
    await vi.waitFor(() =>
      expect(store.P.person(me)).toMatchObject({ picture: expect.stringMatching(/^blob:/) }),
    )
    expect(asked).toEqual([[me]])
    const downloads = fetcher.mock.calls.filter(([, init]) => init?.method !== 'POST')
    expect(downloads.map(([url]) => String(url))).toEqual([
      expect.stringContaining('v=storage-mine'),
    ])
  })

  it('mints 25 pictures in one call for a page naming 25 of 1,000 people, and asks for no other but the caller’s own', async () => {
    const base = snap.profiles[0] as Snapshot['profiles'][number]
    snap.profiles = Array.from({ length: 1000 }, (_, i) => ({
      ...base,
      id: i === 0 ? base.id : crypto.randomUUID(),
      auth_user_id: i === 0 ? 'portrait-account' : `account-${i}`,
      name: `Person ${i}`,
      created_at: new Date(NOW.getTime() + i).toISOString(),
      avatar_storage_id: `storage-${i}` as Id<'_storage'>,
    }))
    // the caller is the first of them, with a picture of their own
    snap.myProfileIds = [base.id]
    const asked: string[][] = []
    network.query.mockImplementation((ref, args: { profile_ids?: string[] }) => {
      if (getFunctionName(ref) !== 'files:mintUrls') return Promise.resolve(null)
      asked.push(args.profile_ids ?? [])
      return mint()
    })
    await store.initStore()
    const page = snap.profiles.slice(500, 525)
    store.P.namePeople(
      'users-page',
      page.map((p) => ({ org: p.org_id, id: p.id })),
    )
    await vi.waitFor(() =>
      expect(page.map((p) => store.P.person(p.id))).toEqual(
        page.map(() => expect.objectContaining({ picture: expect.stringMatching(/^blob:/) })),
      ),
    )
    // the caller's own picture at boot, then the page's 25 in one call
    expect(asked).toEqual([[base.id], page.map((p) => p.id)])
    expect(fetcher).toHaveBeenCalledTimes(26)
  })

  it('reads the face of a person the server’s profiles leave out and shows its picture', async () => {
    await store.initStore()
    const org = snap.orgs[0]?.id ?? ''
    faces = [
      {
        id: 'unheld',
        name: 'Una Unheld',
        org_role: 'user',
        kind: 'person',
        active: true,
        pending: false,
        color: '#335577',
        initials: 'UU',
        avatar: 'storage-unheld',
        sample_avatar: null,
        plannable_hours: 24,
      },
    ]
    store.P.namePeople('board', [{ org, id: 'unheld' }])
    expect(store.P.person('unheld')).toMatchObject({ state: 'loading' })
    await vi.waitFor(() =>
      expect(store.P.person('unheld')).toMatchObject({
        state: 'ok',
        name: 'Una Unheld',
        plannableHours: 24,
        picture: expect.stringMatching(/^blob:/),
      }),
    )
    expect(fetcher).toHaveBeenCalledOnce()
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('v=storage-unheld')
  })

  it('revokes removed versions and clears prepared sources before authentication reinitializes', async () => {
    await store.initStore()
    nameAll()
    await ready()
    const removed = pictures()[0]
    snap.profiles[0].avatar_storage_id = undefined
    deliverChange()
    await vi.waitFor(() => expect(pictures()[0]).toBeNull())
    expect(revoke).toHaveBeenCalledWith(removed)
    const remaining = pictures()[1]
    const pending = deferred<Minted>()
    mint.mockReturnValueOnce(pending.promise)
    await store.initStore()
    nameAll()
    expect(revoke).toHaveBeenCalledWith(remaining)
    expect(pictures().every((picture) => picture === null)).toBe(true)
    pending.resolve(response())
    await vi.waitFor(() => expect(pictures()[1]).toMatch(/^blob:/))
    expect(pictures()[1]).not.toBe(remaining)
  })
})
