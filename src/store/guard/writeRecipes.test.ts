import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fixture,
  NOW,
  type Recipe,
  recipes,
  type Snapshot,
  type Thread,
  thread,
} from './writeRecipes.setup'

/* Every write recipe (writeRecipes.setup.ts) in four scenarios, against the
   Convex double that keeps Convex's order (convexOrder.setup.ts):

   1. Paused, by the snapshot trouble that pauses its class and by the pause
      while Qivo cannot save, it paints nothing and sends nothing.
   2. Refused online, the rows return to exactly what they were.
   3. Sent online, accepted while the snapshot (or the thread) fails, and
      then another painted write refused: the change stays. A delivery of
      the server's rows then ends the trouble, and no layer is left.
   4. With the server's rows delivered before the answer, as Convex does,
      the rows equal them, server stamps aside, and after the answer they
      equal them exactly with no layer left. A paint shown when the write is
      sent equals them too, so a paint that differs from what the server
      stores fails here.

   The store checks every emit against its layers too (checkLayers). */

const double = vi.hoisted(() => ({
  current: null as null | import('./convexOrder.setup').ConvexDouble,
}))
vi.mock('../../lib/convex', async () => {
  const { createConvexDouble } = await import('./convexOrder.setup')
  const { liveOver } = await import('./liveDouble.setup')
  double.current = createConvexDouble()
  return { convex: double.current.client, live: liveOver(double.current.client) }
})
vi.mock('../../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))
// the browser's image re-encoding is not what these recipes test
vi.mock('../../lib/images', async (original) => ({
  ...(await original<typeof import('../../lib/images')>()),
  compressImage: async (file: File) => file,
  avatarImage: async (file: File) => file,
}))

const QUERY_FAILURE = '[CONVEX Q(workspace:whole)] Server Error'
const THREAD_FAILURE = '[CONVEX Q(snapshot:threadComments)] Server Error'
const REFUSAL = () => new ConvexError({ code: 'forbidden', message: 'no write access' })

let store: typeof import('../planner')
let sync: typeof import('../../lib/syncStatus')
let snap: Snapshot
let page: Thread

const P = () => store.P
const server = () => {
  if (!double.current) throw new Error('the Convex double is not set up')
  return double.current
}
const probe = () => {
  if (!store.__layerProbe) throw new Error('the layer probe is test-only')
  return store.__layerProbe
}
/* Lets every answer and paint land: microtasks, a real turn, and the
   store's 0 ms paint timer. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  vi.advanceTimersByTime(0)
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/* The writes the act sends and the answer each gets. */
const names = (recipe: Recipe) => [recipe.mutation, ...Object.keys(recipe.answers ?? {})]
const answerOf = (recipe: Recipe, name: string, args: Record<string, unknown>) =>
  recipe.answers?.[name]?.(args) ?? null

async function boot(recipe: Recipe) {
  vi.resetModules()
  snap = fixture()
  recipe.seed?.(snap)
  page = thread()
  store = await import('../planner')
  sync = await import('../../lib/syncStatus')
  const d = server()
  d.reset()
  d.publish('workspace:whole', snap, false)
  d.publish('snapshot:threadComments', page, false)
  // a new listener gets the held snapshot on a 0 ms timer, as from Convex
  let booted = false
  const booting = store.initStore().then(() => {
    booted = true
  })
  for (let turn = 0; turn < 50 && !booted; turn++) await vi.advanceTimersByTimeAsync(0)
  await booting
  P().watchComments('task-a')
  // a boot run again, such as the seat claim's recipe, waits like any write
  d.holdClaims()
  await recipe.prepare?.(P(), {
    answer: async (name, value, edit) => {
      await settle()
      const [request] = d.take([name])
      if (!request) throw new Error(`${name} was not sent`)
      edit?.(snap)
      d.acceptWith(request, value, edit ? snap : undefined)
    },
  })
  await settle()
}

/* Runs the act and answers its writes with `answer` until no new write
   comes. Answers the names of the writes it sent. */
async function drive(
  recipe: Recipe,
  answer: (
    name: string,
    args: Record<string, unknown>,
    settle: (value: unknown) => void,
    refuse: (e: unknown) => void,
  ) => void,
) {
  // an awaited act may wait for a write the test answers later
  void Promise.resolve(recipe.act(P(), store)).catch(() => null)
  const sentNames: string[] = []
  for (let round = 0; round < 10; round++) {
    await settle()
    const sent = server().take(names(recipe))
    if (!sent.length) break
    for (const request of sent) {
      sentNames.push(request.name)
      answer(request.name, request.args, request.resolve, request.reject)
    }
  }
  await settle()
  return sentNames
}

/* Answers the writes still waiting, as the recipe says, until none come. */
async function answerRest(recipe: Recipe) {
  for (let round = 0; round < 10; round++) {
    await settle()
    const sent = server().take(names(recipe))
    if (!sent.length) return
    for (const request of sent) request.resolve(answerOf(recipe, request.name, request.args))
  }
}

/* The server's rows after the write, from the recipe's arguments. */
function truthOf(recipe: Recipe, args: Record<string, unknown>) {
  const next = structuredClone(snap)
  recipe.truth?.(next, args)
  next.delivered_at = '2026-10-20T10:00:06.000Z'
  return next
}
function threadOf(recipe: Recipe, args: Record<string, unknown>) {
  const next = structuredClone(page)
  recipe.thread?.(next, args)
  return next
}

/* Pauses every write: the browser reports offline long enough. */
function goOffline() {
  sync.syncStatus.setSocket({ connected: false, everConnected: true })
  vi.advanceTimersByTime(sync.OFFLINE_DELAY_MS + 1)
  expect(P().savePause()?.kind).toBe('offline')
}

beforeEach(() => {
  // setImmediate stays real, for work the browser does outside the event loop
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
  vi.setSystemTime(new Date(NOW))
  vi.stubGlobal('window', { showToast: vi.fn(), setTimeout, clearTimeout })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.includes('refused')
        ? { ok: false, status: 500, json: async () => ({ error: { message: 'refused' } }) }
        : { ok: true, status: 200, json: async () => ({ storageId: 'storage-portrait' }) },
    ),
  )
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // a credential's hash, answered within the task rather than on a thread
  vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(new ArrayBuffer(32))
})

afterEach(() => {
  // a fault the store caught (a throw in a paint or an answer) fails the test
  if (store?.__layerProbe) expect(store.__layerProbe.faults()).toEqual([])
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Whether `recipe`'s write paints when it is sent, not only once accepted. */
const paintsAtSend = (recipe: Recipe) => !!(recipe.truth || recipe.thread) && !recipe.paintsOnAccept

describe.each(recipes.map((recipe) => [`${recipe.mutation} (${recipe.what})`, recipe] as const))(
  '%s',
  (_name, recipe) => {
    const pauses =
      recipe.pause === 'P'
        ? ['failed', 'offline']
        : recipe.pause === 'U'
          ? ['no_access', 'offline']
          : ['offline']

    it.each(pauses)('paints and sends nothing while paused (%s)', async (pause) => {
      await boot(recipe)
      if (pause === 'failed') server().fail('workspace:whole', new Error(QUERY_FAILURE))
      else if (pause === 'no_access') server().publish('workspace:whole', null)
      else goOffline()
      await settle()
      const before = probe().rows()
      await drive(recipe, () => {
        throw new Error('a paused write was sent')
      })
      expect(server().requests.filter((r) => names(recipe).includes(r.name))).toEqual([])
      expect(probe().rows()).toEqual(before)
    })

    it('returns to the exact rows when refused', async () => {
      await boot(recipe)
      const before = probe().rows()
      const sent = await drive(recipe, (name, args, resolve, reject) => {
        if (name === recipe.mutation) reject(REFUSAL())
        else resolve(answerOf(recipe, name, args))
      })
      expect(sent).toContain(recipe.mutation)
      expect(probe().rows()).toEqual(before)
      expect(probe().layerCount()).toBe(0)
    })

    it('keeps the change accepted during trouble when another write is refused', async () => {
      await boot(recipe)
      let args: Record<string, unknown> = {}
      let beforeAnswer: Record<string, string> | null = null
      const thread = !!recipe.thread
      const sentNames = await drive(recipe, (name, sent, resolve) => {
        if (name === recipe.mutation) {
          args = sent
          beforeAnswer = probe().rows(true)
          // the query fails before the answer, so no delivery holds the write
          if (thread) server().fail('snapshot:threadComments', new Error(THREAD_FAILURE))
          else server().fail('workspace:whole', new Error(QUERY_FAILURE))
        }
        resolve(answerOf(recipe, name, sent))
      })
      expect(sentNames).toContain(recipe.mutation)
      // a change painted when it was sent is still there once accepted
      if (paintsAtSend(recipe)) expect(probe().rows(true)).toEqual(beforeAnswer)
      const shown = probe().rows()
      // another painted write that still goes out, refused
      if (thread) void P().addComment('task-a', 'Refused comment')
      else {
        const other = ['QN-1', 'QN-2', 'QN-3'].find((key) => P().issueById[key])!
        P().setIssueSubscribed(other, !P().issueById[other].subscribed)
      }
      await settle()
      const refused = server().take()
      expect(refused).toHaveLength(1)
      for (const request of refused) request.reject(REFUSAL())
      await settle()
      expect(probe().rows()).toEqual(shown)
      // the server's rows end the trouble and hold every accepted write
      if (thread) server().publish('snapshot:threadComments', threadOf(recipe, args))
      else server().publish('workspace:whole', truthOf(recipe, args))
      await settle()
      expect(P().snapshotTrouble()).toBeNull()
      expect(probe().layerCount()).toBe(0)
    })

    it('equals the server rows painted over them, and after the answer', async () => {
      await boot(recipe)
      const before = probe().rows(true)
      let pending: Record<string, unknown> | null = null
      let answer: (() => void) | null = null
      await drive(recipe, (name, args, resolve) => {
        if (name !== recipe.mutation) return resolve(answerOf(recipe, name, args))
        pending = args
        answer = () => resolve(answerOf(recipe, name, args))
      })
      if (!pending || !answer) throw new Error(`${recipe.mutation} was not sent`)
      // what the write painted when it was sent, before any delivery
      const early = probe().rows(true)
      // Convex delivers the write before it answers
      if (recipe.thread) server().publish('snapshot:threadComments', threadOf(recipe, pending))
      else server().publish('workspace:whole', truthOf(recipe, pending))
      await settle()
      const painted = probe().rows(true)
      ;(answer as () => void)()
      await answerRest(recipe)
      expect(probe().layerCount()).toBe(0)
      const stored = probe().rows(true)
      expect(painted).toEqual(stored)
      // a paint shown at send already shows what the server stores; a write
      // that paints only once accepted shows nothing before
      if (paintsAtSend(recipe)) expect(early).toEqual(stored)
      else expect(early).toEqual(before)
    })
  },
)
