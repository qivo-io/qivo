import { type FunctionReference, getFunctionName } from 'convex/server'

/* A Convex client double for store tests that keeps Convex's order: a write
   that the server accepts reaches the query listeners first and resolves
   after. Like the real client, it hands every listener of a query the same
   result object, and a new listener the held one on a 0 ms timer
   (lib/convexOrdering.test.ts pins both on the real client). */

/** A write the store sent and the test has not answered yet. */
export type Request = {
  name: string
  args: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

type Subscription = {
  args: Record<string, unknown>
  receive: (value: unknown) => void
  fail: (error: unknown) => void
  closed: boolean
}

/** Creates the double. `client` stands in for lib/convex's `convex`. */
export function createConvexDouble() {
  const requests: Request[] = []
  const subscriptions = new Map<string, Subscription[]>()
  /* The result a query's listeners hold, which a new listener gets, by
     query name. */
  const current = new Map<string, unknown>()
  /* What a one-shot query answers, by query name. */
  const answers = new Map<string, (args: Record<string, unknown>) => unknown>()
  /* Whether the seat claim waits for the test like any write, rather than
     answering at once as the boot needs. */
  let holdClaims = false

  const live = (name: string) => (subscriptions.get(name) ?? []).filter((s) => !s.closed)

  const client = {
    mutation(ref: FunctionReference<'mutation'>, args: Record<string, unknown>) {
      const name = getFunctionName(ref)
      // the boot's seat claim answers at once, unless the test holds it
      if (name === 'identity:claimMySeats' && !holdClaims) return Promise.resolve(null)
      return new Promise((resolve, reject) => requests.push({ name, args, resolve, reject }))
    },
    query(ref: FunctionReference<'query'>, args: Record<string, unknown>) {
      const answer = answers.get(getFunctionName(ref))
      return Promise.resolve(answer ? answer(args) : null)
    },
    onUpdate(
      ref: FunctionReference<'query'>,
      args: Record<string, unknown>,
      receive: (value: unknown) => void,
      fail: (error: unknown) => void,
    ) {
      const name = getFunctionName(ref)
      const subscription: Subscription = { args, receive, fail, closed: false }
      subscriptions.set(name, [...(subscriptions.get(name) ?? []), subscription])
      if (current.has(name))
        setTimeout(() => {
          if (!subscription.closed && current.has(name)) receive(current.get(name))
        }, 0)
      return () => {
        subscription.closed = true
      }
    },
  }

  return {
    client,
    requests,
    /** Makes the seat claim wait for the test, for a boot run again. */
    holdClaims() {
      holdClaims = true
    },
    /** Forgets everything, for the next test. */
    reset() {
      holdClaims = false
      requests.length = 0
      subscriptions.clear()
      current.clear()
      answers.clear()
    },
    /** Sets what query `name` delivers to a new subscription, and delivers
        it to the live ones when `now`. Each call is a new result object. */
    publish(name: string, value: unknown, now = true) {
      const result = structuredClone(value)
      current.set(name, result)
      if (now) for (const s of live(name)) s.receive(result)
    },
    /** Fails the live subscriptions of query `name`. */
    fail(name: string, error: unknown) {
      for (const s of live(name)) s.fail(error)
    },
    /** Answers one-shot query `name` with `answer`. */
    answer(name: string, answer: (args: Record<string, unknown>) => unknown) {
      answers.set(name, answer)
    },
    /** Removes and returns the waiting writes, of `names` only when given. */
    take(names?: readonly string[]) {
      const taken = requests.filter((r) => !names || names.includes(r.name))
      for (const r of taken) requests.splice(requests.indexOf(r), 1)
      return taken
    },
    /** Accepts `request` with `value` the way Convex does: the snapshot
        `truth`, when given, reaches the listeners first, then the write
        resolves. */
    acceptWith(request: Request, value: unknown, truth?: unknown) {
      if (truth !== undefined) this.publish('workspace:whole', truth)
      request.resolve(value)
    },
  }
}

export type ConvexDouble = ReturnType<typeof createConvexDouble>
