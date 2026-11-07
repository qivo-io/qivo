/* The one queue every file URL mint of the store goes through
   (files.mintUrls); the browser export (lib/orgExport.ts) mints its one
   file a call itself. It bounds the calls: at most MINT_QUEUE.batch ids a
   call, at most MINT_QUEUE.inFlight calls at once, attachments and
   pictures never in one call, and attachment calls before picture calls,
   so an image someone is looking at overtakes the roster's pictures. The
   server refuses a call past its own caps (convex/files.ts MINT_IDS), which
   these chunks stay under. While the page is hidden no call starts
   (pause); the calls on their way finish, and the waiting requests go once
   it shows. The planner builds one queue a store, with its query
   injected, so the tests need no store. */

/** The queue's bounds, an object the tests lower. A call that has not
    answered after `timeout` ms answers failed for its ids and keeps its
    slot until it settles, so the server never holds more than `inFlight`
    of the store's mints at once, apart from calls a clear() let go. */
export const MINT_QUEUE = { batch: 100, inFlight: 2, timeout: 15_000 }

/** One file to mint: an attachment, or a profile's picture, through
    organization `org`. `key` names it for sharing: requests with the same
    key share one answer while it is waiting or on its way. */
export type MintRequest = { kind: 'attachment' | 'avatar'; id: string; org: string; key: string }

/** A minted URL and its expiry in unix seconds. */
export type MintLease = { url: string; exp: number }

/** What a request answers: its lease, `missing` when the answer omitted
    the id (missing, foreign and invisible alike), `refused` when the call
    was refused (a ConvexError), or `failed` for any other failure, the
    call's timeout, or a queue cleared before the answer. */
export type MintOutcome =
  | { state: 'lease'; lease: MintLease }
  | { state: 'missing' }
  | { state: 'refused' }
  | { state: 'failed' }

/** The call the queue makes, files.mintUrls through organization `org`. */
export type MintCall = (
  org: string,
  ids: { attachment_ids?: string[]; profile_ids?: string[] },
) => Promise<{ attachments: Record<string, MintLease>; avatars: Record<string, MintLease> }>

type Waiting = {
  request: MintRequest
  answer: Promise<MintOutcome>
  settle: (outcome: MintOutcome) => void
}

type Options = {
  /** whether a failed call's error is a refusal (a ConvexError) */
  refused: (error: unknown) => boolean
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  /** runs a task once the current synchronous run ends, by default in a
      microtask, so the requests of one run (the views one commit mounts,
      or the entries one observer callback brings near) share calls */
  later?: (task: () => void) => void
}

/** A mint queue over `mint`. */
export function createMintQueue(mint: MintCall, options: Options) {
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const later = options.later ?? ((task) => queueMicrotask(task))
  // waiting requests by kind, then by organization, in the order asked
  const waiting = {
    attachment: new Map<string, Waiting[]>(),
    avatar: new Map<string, Waiting[]>(),
  }
  const known = new Map<string, Waiting>() // waiting or on their way, by key
  let running = 0
  let mostRunning = 0
  let sent = 0
  let generation = 0
  let pumping = false
  let paused = false

  /* The next chunk to send: attachments first, then pictures, each the
     longest-waiting organization's first `batch` requests. */
  const nextChunk = (): { kind: MintRequest['kind']; org: string; items: Waiting[] } | null => {
    for (const kind of ['attachment', 'avatar'] as const) {
      for (const [org, list] of waiting[kind]) {
        const items = list.splice(0, MINT_QUEUE.batch)
        if (list.length === 0) waiting[kind].delete(org)
        if (items.length) return { kind, org, items }
      }
    }
    return null
  }

  const send = (chunk: { kind: MintRequest['kind']; org: string; items: Waiting[] }) => {
    const version = generation
    running++
    sent++
    mostRunning = Math.max(mostRunning, running)
    let answered = false
    const answer = (outcome: (w: Waiting) => MintOutcome) => {
      if (answered) return
      answered = true
      clearTimer(timer)
      for (const w of chunk.items) {
        if (known.get(w.request.key) === w) known.delete(w.request.key)
        w.settle(version === generation ? outcome(w) : { state: 'failed' })
      }
    }
    const timer = setTimer(() => answer(() => ({ state: 'failed' })), MINT_QUEUE.timeout)
    const ids = [...new Set(chunk.items.map((w) => w.request.id))]
    let call: ReturnType<MintCall>
    try {
      call = mint(
        chunk.org,
        chunk.kind === 'attachment' ? { attachment_ids: ids } : { profile_ids: ids },
      )
    } catch (error) {
      call = Promise.reject(error)
    }
    void call
      .then(
        (res) => {
          const leases = chunk.kind === 'attachment' ? res?.attachments : res?.avatars
          // an answer without its leases is no answer: nothing is omitted
          if (!leases || typeof leases !== 'object') return answer(() => ({ state: 'failed' }))
          answer((w) => {
            const lease = leases[w.request.id]
            return lease ? { state: 'lease', lease } : { state: 'missing' }
          })
        },
        (error: unknown) => {
          const refused = options.refused(error)
          answer(() => ({ state: refused ? 'refused' : 'failed' }))
        },
      )
      .finally(() => {
        // a cleared queue already let its calls go
        if (version !== generation) return
        running--
        pump()
      })
  }

  const pump = () => {
    while (!paused && running < MINT_QUEUE.inFlight) {
      const chunk = nextChunk()
      if (!chunk) return
      send(chunk)
    }
  }

  const schedule = () => {
    if (pumping) return
    pumping = true
    later(() => {
      pumping = false
      pump()
    })
  }

  return {
    /** The answer for `request`, sharing the one of a request with its key
        that is waiting or on its way. Requests wait until the next
        microtask, so those one synchronous run makes share calls; requests
        made in separate tasks go in separate calls. */
    request(request: MintRequest): Promise<MintOutcome> {
      const shared = known.get(request.key)
      if (shared) return shared.answer
      let settle!: (outcome: MintOutcome) => void
      const answer = new Promise<MintOutcome>((resolve) => {
        settle = resolve
      })
      const w: Waiting = { request, answer, settle }
      known.set(request.key, w)
      const byOrg = waiting[request.kind]
      const list = byOrg.get(request.org)
      if (list) list.push(w)
      else byOrg.set(request.org, [w])
      schedule()
      return answer
    },
    /** How many calls are on their way, and the most at once, for the
        tests and the measurement. */
    running: () => running,
    mostRunning: () => mostRunning,
    /** How many calls the queue has sent. */
    sent: () => sent,
    /** While the page is hidden (true) no call starts. The calls on their
        way finish, and the requests waiting go once it shows (false). A
        clear() keeps the pause, which follows the page. */
    pause(hidden: boolean) {
      if (paused === hidden) return
      paused = hidden
      if (!hidden) pump()
    },
    /** Answers every request still waiting or on its way `failed` and lets
        the calls on their way go, for sign-out, a demo's end and
        reinitialization. Their answers are dropped when they come. */
    clear() {
      generation++
      running = 0
      for (const list of [...waiting.attachment.values(), ...waiting.avatar.values()])
        for (const w of list) w.settle({ state: 'failed' })
      waiting.attachment.clear()
      waiting.avatar.clear()
      for (const w of known.values()) w.settle({ state: 'failed' })
      known.clear()
    },
  }
}

export type MintQueue = ReturnType<typeof createMintQueue>
