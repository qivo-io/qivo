/* The machine action registry, the shape both machine surfaces use to declare
 * what they serve. Every organization REST route (machine/rest.ts ROUTES) and
 * every MCP tool (machine/mcp.ts TOOLS) is ONE entry with a required `access`
 * flag and a `run` that calls the endpoint's internal function. There is no
 * default, so an entry without the flag does not compile. The /v1/webhooks
 * routes and the MCP events/* methods are served outside the registry, with
 * their own credential checks.
 *
 * The flag is the single source for the MCP OAuth step-up (a write tool needs
 * qivo:write, else HTTP 403 insufficient_scope) and for the guard tests that
 * compare each flag with the kind of function the entry calls
 * (convex/tests/registry.test.ts) and drive every write entry with a
 * read-only credential (convex/tests/credentialAccess.test.ts).
 *
 * Every entry receives the Principal, which is the caller's profile uuid and
 * what its credential may do. `run` passes both to the internal function, whose
 * asMachineCaller refuses a write from a credential that can only read.
 *
 * A read entry receives a runner that can only run queries, by type AND at
 * runtime. runEntry hands it an object whose only function is a bound
 * runQuery, so a cast cannot reach a mutation or an action through it. Both
 * runners carry a brand that only readRunner and writeRunner set, so passing
 * a raw ctx to an entry's `run` does not compile and runEntry is the way to
 * dispatch. Every check fails closed. Only an exact 'write' flag gets the
 * write runner, and anything but an exact 'read' flag needs write access from
 * the credential (needsWrite).
 *
 * The write runner's runMutation retries write conflicts and mutation time
 * outs (retryConflicts). Every write entry makes exactly one write call, one
 * mutation or one action, and registry.test.ts holds every entry to that. So
 * a failure that outlasts the retries means the request changed nothing, and its
 * WRITE_CONFLICT refusal tells the caller so. The surfaces run the mutations
 * they make before dispatch, such as the per-call stamp, through
 * conflictRetrying for the same reason.
 *
 * A write entry refused because its task's comments are still being counted
 * (lib/limits.ts COMMENTS_COUNTING) then starts that count in a mutation of
 * its own (commentLimits.ts begin), because the refusal undid what it
 * wrote, so a later request can pass. */

import { ConvexError } from 'convex/values'
import { internal } from '../_generated/api'
import type { ActionCtx } from '../_generated/server'
import type { CredentialAccess } from '../lib/enums'
import { conflict, type Refusal } from '../lib/functions'
import { COMMENTS_COUNTING } from '../lib/limits'
import { WRITE_CONFLICT, WRITE_CONFLICT_MESSAGE, WRITE_TIMEOUT_MESSAGE } from './shared'

/* convex/tsconfig's lib is ESNext only; the Convex runtime has it. */
declare function setTimeout(callback: () => void, delay: number): unknown

/** Whether a machine action only reads data or may change it. */
export type MachineAccess = 'read' | 'write'

/**
 * Who runs a machine action, as the profile uuid the auth step resolved and
 * what its credential may do (lib/access.ts credentialAccess).
 */
export type Principal = { callerId: string; access: CredentialAccess }

/* Brands the runners below. Module-private, so no other code can turn a raw
 * ctx into a runner without going through readRunner or writeRunner. */
const brand = Symbol('machine runner')

/** The parts of an action ctx that the runners are built from. */
type Runners = Pick<ActionCtx, 'runQuery' | 'runMutation' | 'runAction'>

/** What a read entry may call, which is queries only. */
export type ReadRunner = Pick<ActionCtx, 'runQuery'> & { readonly [brand]: 'read' }

/** What a write entry may call, which is queries, mutations and actions. */
export type WriteRunner = Runners & { readonly [brand]: 'write' }

/**
 * One machine action, generic over the surface's parsed input and its result.
 * The union on `access` types `run`'s runner, so the compiler refuses a read
 * entry that calls runMutation or runAction.
 */
export type MachineEntry<Input, Output> =
  | { access: 'read'; run: (runner: ReadRunner, input: Input) => Promise<Output> }
  | { access: 'write'; run: (runner: WriteRunner, input: Input) => Promise<Output> }

/** A runner whose only function is runQuery, bound to `ctx`. */
export function readRunner(ctx: Pick<ActionCtx, 'runQuery'>): ReadRunner {
  return { runQuery: ctx.runQuery.bind(ctx), [brand]: 'read' }
}

/** A runner holding runQuery, runMutation and runAction, bound to `ctx`.
 * Its runMutation retries write conflicts and time outs (conflictRetrying).
 * runAction does not, because an action may have committed mutations before
 * it failed. */
export function writeRunner(ctx: Runners): WriteRunner {
  return {
    runQuery: ctx.runQuery.bind(ctx),
    runMutation: conflictRetrying(ctx),
    runAction: ctx.runAction.bind(ctx),
    [brand]: 'write',
  }
}

/* What ctx.runMutation rejects with once a mutation's transaction kept
 * conflicting with other writes and Convex stopped retrying it. It is a
 * plain Error whose message is the backend's optimistic concurrency failure,
 * ErrorMetadata::user_occ in convex-backend's errors crate, or OCC_ERROR_MSG
 * for a conflict on a system table. A user_occ message reads, for example,
 * `Documents read from or written to the "messages" table changed
 * while this mutation was being run and on every subsequent retry. Another
 * call to this mutation changed the document with ID "…". See
 * https://docs.convex.dev/error#1`. Such a transaction never committed. The
 * message is the only sign of it, so both patterns are anchored at the
 * start, and an error that only quotes one does not match. */
const CONFLICT_FAILURES = [
  /^Documents read from or written to .+ changed while this mutation was being run and on every subsequent retry\./,
  /^Data read or written in this mutation changed while it was being run\./,
]

/** Whether `e` is Convex's report of a mutation that gave up on a write
 * conflict, which committed nothing. */
export function isWriteConflict(e: unknown): boolean {
  return (
    e instanceof Error &&
    !(e instanceof ConvexError) &&
    CONFLICT_FAILURES.some((failure) => failure.test(e.message))
  )
}

/* What ctx.runMutation rejects with once a mutation ran past Convex's 1 s
 * execution time, the limit of queries and mutations only. A mutation that
 * Convex retries on conflicts while the deployment is busy can reach it
 * before it gives up on the conflict, and the local backend answered two
 * comment posts racing on one task with it. Such a transaction never
 * committed either. Anchored at the start like CONFLICT_FAILURES. */
const TIMEOUT_FAILURE = /^Function execution timed out \(maximum duration: 1s\)/

/** Whether `e` is Convex's report of a mutation that ran out of execution
 * time, which committed nothing. */
export function isMutationTimeout(e: unknown): boolean {
  return e instanceof Error && !(e instanceof ConvexError) && TIMEOUT_FAILURE.test(e.message)
}

/** How many more times retryConflicts runs a write that conflicted or ran
 * out of time. */
export const CONFLICT_RETRIES = 2

/**
 * Runs `write`, one mutation call, and runs it again up to CONFLICT_RETRIES
 * times, after a random wait, while it fails with a write conflict or runs
 * out of time. Such a mutation committed nothing, so a retry cannot apply it
 * twice. Any other failure is rethrown at once, because it may have come
 * after a commit. A failure that outlasts the retries is logged and becomes
 * the WRITE_CONFLICT refusal, whose sentence says which of the two it was.
 */
export async function retryConflicts<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await write()
    } catch (e) {
      const timeout = isMutationTimeout(e)
      if (!timeout && !isWriteConflict(e)) throw e
      if (attempt === CONFLICT_RETRIES) {
        console.error(e)
        throw conflict(timeout ? WRITE_TIMEOUT_MESSAGE : WRITE_CONFLICT_MESSAGE, WRITE_CONFLICT)
      }
    }
    // 100 to 300 ms before the first retry and 200 to 600 ms before the
    // second, random so that writers that collided do not collide again
    const wait = (attempt + 1) * (100 + Math.random() * 200)
    await new Promise<void>((resolve) => setTimeout(resolve, wait))
  }
}

/**
 * `ctx.runMutation`, with every call run through retryConflicts. Like the
 * bound runners above, it passes on the reference its caller names. Name
 * the result runMutation and call it with an `internal.…` reference, so the
 * credential access walk (convex/tests/credentialAccess.test.ts) reads and
 * checks each call where it is made.
 */
export function conflictRetrying(ctx: Pick<ActionCtx, 'runMutation'>): ActionCtx['runMutation'] {
  const run = ctx.runMutation.bind(ctx)
  return (mutation, ...args) => retryConflicts(() => run(mutation, ...args))
}

/** After `e`, a write's refusal, starts the count of the task whose
 * comments it was refused for while they are counted (COMMENTS_COUNTING).
 * Any other failure is left alone. A count that cannot start is logged, and
 * the caller still answers the refusal. */
async function beginCountAfter(ctx: Pick<ActionCtx, 'runMutation'>, e: unknown): Promise<void> {
  if (!(e instanceof ConvexError)) return
  const { reason, task_id } = e.data as Partial<Refusal>
  if (reason !== COMMENTS_COUNTING || typeof task_id !== 'string') return
  const runMutation = conflictRetrying(ctx)
  try {
    await runMutation(internal.commentLimits.begin, { issue_id: task_id })
  } catch (error) {
    console.error('A comment count did not start after a refused post', { task_id, error })
  }
}

/**
 * Runs `entry` with the narrowest runner its access flag allows. Only an
 * exact 'write' gets the write runner, so a flag that slipped past the types
 * gets the read runner. A write entry's refusal for a count under way
 * starts that count (beginCountAfter) before it is rethrown.
 */
export async function runEntry<Input, Output>(
  ctx: Runners,
  entry: MachineEntry<Input, Output>,
  input: Input,
): Promise<Output> {
  if (entry.access !== 'write') return await entry.run(readRunner(ctx), input)
  try {
    return await entry.run(writeRunner(ctx), input)
  } catch (e) {
    await beginCountAfter(ctx, e)
    throw e
  }
}

/**
 * Whether the credential needs write access to run `entry`. Anything but an
 * exact 'read' counts as a write, so a flag that slipped past the types fails
 * closed.
 */
export function needsWrite(entry: { access: MachineAccess }): boolean {
  return entry.access !== 'read'
}
